import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { batch, repository } from '../scripts/candidate-pipeline.mjs';
import { sha256 } from '../scripts/collection-checkpoints.mjs';
import { validateReleaseMetadata, selectReleaseSQL, validateOriginalCatalog, sqlZipFiles } from '../scripts/rebuild-release-image.mjs';

function fixture() {
  const producer = { commit: 'a'.repeat(40), runId: '100', attempt: '1' }, tag = 'data-r100-a1';
  const datasets = batch.targets.map(t => ({ id: t.id, platform: t.platform, version: t.version, build: t.build,
    components: batch.jobs.filter(c => c.target === t.id).map(c => ({ key: c.key, schema: c.schema, packageManifest: 'c'.repeat(64) })) }));
  const catalog = { allPlannedTargets: true, missingTargets: [], database: 'localization_staging', searchScope: 'one-platform-major-version',
    datasets, inputs: datasets.map(d => ({ target: d.id, bundleSha256: 'd'.repeat(64) })) };
  const image = { reference: 'kishikawakatsumi/applelocalization-data@sha256:' + 'e'.repeat(64),
    identity: sha256(JSON.stringify(catalog)), catalogSha256: sha256(JSON.stringify(catalog, null, 2) + '\n') };
  const artifacts = [...datasets.map(d => `candidate-sql-${d.id}-101-1`), 'unified-candidate-receipts-100-1'].map((name, i) => ({
    id: i + 1, name, size: 100, digest: 'sha256:' + 'f'.repeat(64), runId: name.startsWith('candidate') ? 101 : 100, attempt: 1, commit: producer.commit }));
  const manifest = { formatVersion: 1, repository, tag, producer, archiveCommit: 'b'.repeat(40), datasets, artifacts, image };
  const manifestHash = sha256(JSON.stringify(manifest));
  const assets = [...artifacts.map(a => ({ id: a.id + 1000, name: `${a.name}.zip`, size: a.size, digest: a.digest, state: 'uploaded' })),
    { id: 2000, name: 'data-manifest.json', size: 1000, digest: `sha256:${manifestHash}`, state: 'uploaded' },
    { id: 2001, name: 'SHA256SUMS', size: 100, digest: 'sha256:' + '0'.repeat(64), state: 'uploaded' }];
  const release = { id: 1, tag_name: tag, draft: false, html_url: `https://github.com/${repository}/releases/tag/${tag}` };
  const pushed = { producer, digest: image.reference, identity: image.identity, catalogSha256: image.catalogSha256 };
  return { manifest, manifestHash, catalog, pushed, assets, tag, release };
}
test('published Release manifest must match an independently supplied hash', () => {
  const f = fixture();
  assert.equal(validateReleaseMetadata(f.release, f.assets, f.tag, f.manifestHash).id, 2000);
  assert.throws(() => validateReleaseMetadata({ ...f.release, draft: true }, f.assets, f.tag, f.manifestHash));
  assert.throws(() => validateReleaseMetadata(f.release, f.assets, f.tag, '0'.repeat(64)));
  assert.throws(() => validateReleaseMetadata(f.release, [...f.assets, f.assets[0]], f.tag, f.manifestHash));
  assert.throws(() => validateReleaseMetadata({ ...f.release, html_url: 'https://example.com' }, f.assets, f.tag, f.manifestHash));
});
test('selects all exact Release SQL assets without needing live Actions records', () => {
  const f = fixture(), p = selectReleaseSQL(f.manifest, f.assets, f.tag);
  assert.equal(p.entries.length, 12); assert.equal(p.entries.flatMap(e => e.dataset.components).length, 36);
  assert.ok(p.entries.every(e => e.asset.id !== e.pin.id));
  assert.equal(p.receipt.name, 'unified-candidate-receipts-100-1.zip');
  for (const mutate of [x => x.assets.pop(), x => x.assets[0].digest = 'sha256:' + '1'.repeat(64),
    x => x.manifest.datasets.pop(), x => x.manifest.datasets[0].build = 'wrong',
    x => x.manifest.artifacts[0].name = '../unsafe', x => x.manifest.datasets[0].components.pop()]) {
    const bad = structuredClone(f); mutate(bad); assert.throws(() => selectReleaseSQL(bad.manifest, bad.assets, bad.tag));
  }
});
test('retained catalog, bundle pins and original image identity stay exact', () => {
  const f = fixture(); validateOriginalCatalog(f.manifest, f.catalog, f.pushed);
  for (const mutate of [x => x.catalog.inputs[0].bundleSha256 = '0'.repeat(64),
    x => x.pushed.identity = '0'.repeat(64), x => x.catalog.datasets[0].components[0].schema = 'other',
    x => x.catalog.allPlannedTargets = false]) {
    const bad = structuredClone(f); mutate(bad); assert.throws(() => validateOriginalCatalog(bad.manifest, bad.catalog, bad.pushed));
  }
  assert.equal(sqlZipFiles(f.manifest.datasets[0]).length, 10);
});
test('ZIP unpacking rejects traversal, duplicate entries, symlinks, extras and omissions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'release-zip-test-'));
  execFileSync('python3', ['-c', `import sys, zipfile, stat, os
root=sys.argv[1]
for kind in ['valid','traversal','duplicate','symlink','extra','missing']:
    with zipfile.ZipFile(os.path.join(root,kind+'.zip'),'w') as z:
        if kind != 'missing': z.writestr('bundle.json','{}')
        if kind == 'traversal': z.writestr('../outside','no')
        if kind == 'duplicate': z.writestr('bundle.json','{}')
        if kind == 'symlink':
            i=zipfile.ZipInfo('link'); i.create_system=3; i.external_attr=(stat.S_IFLNK|0o777)<<16; z.writestr(i,'/etc/passwd')
        if kind == 'extra': z.writestr('.env','secret')
`, root], { stdio: ['ignore', 'ignore', 'pipe'] });
  const unpack = (kind, names = ['bundle.json']) => execFileSync('python3', ['scripts/unpack-release-sql.py',
    '--archive', join(root, `${kind}.zip`), '--output', join(root, kind), '--files', JSON.stringify(names)], { stdio: 'pipe' });
  unpack('valid'); assert.equal(await readFile(join(root, 'valid/bundle.json'), 'utf8'), '{}');
  assert.throws(() => unpack('valid'));
  for (const kind of ['traversal', 'duplicate', 'extra', 'missing']) assert.throws(() => unpack(kind));
  assert.throws(() => unpack('symlink', ['bundle.json', 'link']));
});
test('rebuild workflow has no artifact-download or Actions-read dependency, and never deploys', async () => {
  const workflow = await readFile('.github/workflows/localization-rebuild-release.yml', 'utf8');
  assert.doesNotMatch(workflow, /download-artifact|actions: read|ssh-action|tags:.*latest/);
  assert.match(workflow, /manifest_sha256:/); assert.match(workflow, /--allow-unrestored-candidate/);
  const script = await readFile('scripts/rebuild-release-image.mjs', 'utf8');
  assert.doesNotMatch(script, /actions\/artifacts|actions\/runs/);
  assert.match(script, /releases\/assets/); assert.match(script, /unifiedRestoreVerified: false/);
});
