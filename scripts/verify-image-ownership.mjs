// Explicitly re-evaluate all indexed resources with both saved v4 and opt-in v5.
// Fail closed on any boundary change; never silently relabel a saved scan.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { lstat, realpath } from 'node:fs/promises';
import { dirname } from 'node:path';
import { assignBundle, bundlePolicies } from './bundle-assignment.mjs';
import { readBundleMetadata } from './bundle-metadata.mjs';
import { safeRead } from './inspect-unlocalized-resources.mjs';
import { readJsonLines, sha256 } from './localization-jsonl.mjs';
import { validateOwnershipChange } from './package-ownership.mjs';

export async function verifyImageOwnership({ root, scan, requireReadOnlyMount = true, decode = readBundleMetadata, reviewChanges = false }) {
  root = await realpath(root);
  assert.notEqual(root, '/');
  if (requireReadOnlyMount) {
    const line = execFileSync('/sbin/mount', [], { encoding: 'utf8' }).split('\n').find(l => l.includes(` on ${root} (`));
    assert.ok(line?.split(' (').at(-1).replace(/\)$/, '').split(', ').includes('read-only'));
  }
  const reportBytes = await safeRead(scan, 'report.json'), report = JSON.parse(reportBytes);
  assert.equal(report.source.scope.kind, 'whole-image');
  assert.equal(await realpath(report.source.root), root);
  assert.deepEqual(report.bundlePolicy, bundlePolicies[4]);
  const device = (await lstat(root)).dev, cache = new Map([['', [null, null]]]);
  const hashes = {}, ids = new Set(), metadata = new Set(), issues = [];
  const changes = [], remaining = [], assignments = {};
  const counts = { files: 0, changedFiles: 0, previouslyUnbundled: 0, nestedBoundaryChanges: 0, affectedRowsFromIndex: 0 };
  async function directory(path) {
    if (cache.has(path)) return cache.get(path);
    const inherited = await directory(dirname(path) === '/' ? '' : dirname(path));
    const info = await lstat(root + path);
    assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.dev === device);
    const results = [];
    for (const [index, version] of [4, 5].entries()) {
      const bundle = await assignBundle({ path: root + path, imagePath: path, inherited: inherited[index], device,
        policy: bundlePolicies[version], decode, onIssue: (imagePath, e) => issues.push({ version, imagePath, error: e.message }) });
      for (const m of bundle?.evidence.metadata ?? []) {
        assert.equal(sha256(await safeRead(root, m.imagePath.slice(1))), m.sha256);
        metadata.add(m.imagePath);
      }
      results.push(bundle);
    }
    cache.set(path, results);
    return results;
  }
  for await (const f of readJsonLines(scan, 'files.jsonl.gz', hashes)) {
    assert.ok(typeof f.imagePath === 'string' && f.imagePath.startsWith('/') && f.imagePath.slice(1).split('/').every(p => p && p !== '.' && p !== '..'));
    assert.equal(f.sourceId, report.source.sourceId);
    assert.equal(f.resourceId, sha256(JSON.stringify([f.sourceId, f.imagePath])));
    assert.ok(!ids.has(f.resourceId)); ids.add(f.resourceId);
    assert.equal(sha256(await safeRead(root, f.imagePath.slice(1))), f.sha256);
    const [old, next] = await directory(dirname(f.imagePath));
    assert.equal(old?.path ?? null, f.bundlePath, 'Saved v4 owner differs from original');
    assert.equal(old?.assignment ?? 'unbundled', f.bundleAssignment);
    assert.deepEqual(old?.evidence ?? null, f.bundleEvidence ?? null);
    assert.equal(f.resourcePath, f.bundlePath ? f.imagePath.slice(f.bundlePath.length + 1) : f.imagePath.slice(1));
    if (!reviewChanges) {
      assert.equal(next?.path ?? null, f.bundlePath, `v5 boundary change requires explicit correction: ${f.imagePath}`);
      assert.equal(next?.assignment ?? 'unbundled', f.bundleAssignment);
      assert.deepEqual(next?.evidence.problems ?? [], [], 'Unresolved ownership metadata');
    } else {
      const assignment = next?.assignment ?? 'unbundled';
      counts.files++;
      assignments[assignment] = (assignments[assignment] ?? 0) + 1;
      if ((next?.path ?? null) !== f.bundlePath) {
        const change = { resourceId: f.resourceId, sourceId: f.sourceId, imagePath: f.imagePath, resourceSha256: f.sha256,
          before: { bundlePath: f.bundlePath, resourcePath: f.resourcePath, assignment: f.bundleAssignment },
          after: { bundlePath: next?.path, resourcePath: f.imagePath.slice(next.path.length + 1), assignment, evidence: next.evidence },
          indexedRows: f.status === 'parsed' ? f.rows : 0 };
        validateOwnershipChange(f, change);
        changes.push(change); counts.changedFiles++;
        counts[f.bundlePath === null ? 'previouslyUnbundled' : 'nestedBoundaryChanges']++;
        counts.affectedRowsFromIndex += change.indexedRows;
      } else assert.equal(assignment, f.bundleAssignment, 'Unrepresented assignment change');
      if (assignment !== 'nearest-supported-bundle-metadata' || next?.evidence.problems.length) {
        remaining.push({ resourceId: f.resourceId, imagePath: f.imagePath, bundlePath: next?.path ?? null, assignment, problems: next?.evidence.problems ?? [] });
      }
    }
  }
  assert.equal(ids.size, report.counts.resourceFiles);
  if (reviewChanges) return { status: 'verified-ownership-overlay-not-applied', formatVersion: 1, sourceId: report.source.sourceId,
    scope: report.source.scope, policy: bundlePolicies[5], counts, assignments, changes, remaining, issues,
    verifiedMetadataFiles: metadata.size, inputHashes: { scanReport: sha256(reportBytes), index: hashes['files.jsonl.gz'] },
    limitations: ['Only indexed resource ancestors; recorded inaccessible subtrees remain unverified.',
      'Saved v4 metadata/ownership matched originals; only validated v5 inner boundaries may change.',
      'Unconfirmed assignments and metadata issues retained, not approved. No values or languages changed.'], published: false };
  assert.deepEqual(issues, [], 'Ownership ancestor inspection issues');
  return { status: 'image-ownership-v4-v5-unchanged-verified', sourceId: report.source.sourceId,
    resources: ids.size, verifiedMetadataFiles: metadata.size, changedBoundaries: 0,
    inputHashes: { report: sha256(reportBytes), ...hashes }, policies: [bundlePolicies[4], bundlePolicies[5]],
    limitations: ['Only indexed resource ancestors; empty frameworks may retain scan warnings.',
      'Allowlisted on-disk metadata rules, not runtime or code-signature validation.'], published: false };
}
