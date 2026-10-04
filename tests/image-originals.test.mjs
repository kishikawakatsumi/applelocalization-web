import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { extractMountedImage } from '../scripts/extract-mounted-image.mjs';
import { verifyImageOwnership } from '../scripts/verify-image-ownership.mjs';
import { gzipSync } from 'node:zlib';
import { inspectUnlocalizedResources } from '../scripts/inspect-unlocalized-resources.mjs';
import { extractFilenameSupplement } from '../scripts/extract-filename-localizations.mjs';
import { prepareLocalizationPackage, auditLocalizationPackage } from '../scripts/prepare-localization-package.mjs';
import { readJsonLines, sha256 } from '../scripts/localization-jsonl.mjs';

test('independent original-value audit: Python fixtures and mutation rejection', () => {
  execFileSync('python3', ['-B', 'tests/audit_image_originals.py'], { timeout: 30000 });
});

test('structured strings rescan audit rejects changed old/new values and provenance', () => {
  execFileSync('python3', ['-B', 'tests/structured_strings_rescan.py'], { timeout: 30000 });
});

async function fixture(nested = false) {
  const base = await mkdtemp(join(tmpdir(), 'ownership-originals-'));
  const root = join(base, 'image'), scan = join(base, 'scan');
  const put = async (path, value) => {
    await mkdir(join(root, path, '..'), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(value));
  };
  await put('A.app/Contents/Info.plist', { CFBundleIdentifier: 'example.a' });
  const dir = nested ? 'A.app/Contents/Resources/Guide.help' : 'A.app/Contents/Resources';
  if (nested) await put(dir + '/Info.plist', { CFBundleIdentifier: 'example.help' });
  await put(dir + '/ja.lproj/Localizable.strings', { Open: '開く' });
  const decode = bytes => JSON.parse(bytes.toString());
  // Exercise the historical v4-to-v5 overlay, not the current default policy.
  await extractMountedImage({ root, output: scan, label: 'fixture', decode, requireReadOnlyMount: false, minimumFreeBytes: 0, bundlePolicyVersion: 4 });
  return { root, scan, decode, requireReadOnlyMount: false };
}

test('ownership validates every original with v4 and v5 without relabeling', async () => {
  const result = await verifyImageOwnership(await fixture());
  assert.equal(result.resources, 1);
  assert.equal(result.changedBoundaries, 0);
});

test('ownership refuses an uncorrected inner v5 boundary', async () => {
  await assert.rejects(verifyImageOwnership(await fixture(true)), /v5 boundary change/);
});

test('ownership refuses changed original metadata', async () => {
  const options = await fixture();
  await writeFile(join(options.root, 'A.app/Contents/Info.plist'), JSON.stringify({ CFBundleIdentifier: 'example.changed' }));
  await assert.rejects(verifyImageOwnership(options), /Expected values to be strictly deep-equal/);
});

test('explicit whole-image ownership overlay preserves values and original context through package audit', async () => {
  const options = await fixture(true);
  const review = await verifyImageOwnership({ ...options, reviewChanges: true });
  assert.equal(review.counts.changedFiles, 1);
  assert.equal(review.counts.nestedBoundaryChanges, 1);
  const parent = join(options.scan, '..'), ownership = join(parent, 'ownership');
  await mkdir(ownership);
  const { changes, ...report } = review;
  const overlay = gzipSync(changes.map(c => JSON.stringify(c) + '\n').join(''));
  report.overlaySha256 = sha256(overlay);
  await writeFile(join(ownership, 'ownership.jsonl.gz'), overlay);
  await writeFile(join(ownership, 'report.json'), JSON.stringify(report));
  const inspection = join(parent, 'inspection'), supplement = join(parent, 'supplement'), output = join(parent, 'package');
  await inspectUnlocalizedResources({ ...options, input: options.scan, output: inspection });
  await extractFilenameSupplement({ ...options, inspection, output: supplement });
  const pkgOptions = { ...options, ownership, supplement, output, minimumFreeBytes: 0 };
  const pkg = await prepareLocalizationPackage(pkgOptions);
  assert.equal(pkg.formatVersion, 2);
  assert.equal((await auditLocalizationPackage({ ...pkgOptions, input: output })).status, 'package-content-verified');
  for await (const r of readJsonLines(output, 'resources.jsonl.gz')) {
    assert.equal(r.original.bundlePath, '/A.app');
    assert.equal(r.effective.bundlePath, '/A.app/Contents/Resources/Guide.help');
  }
  report.scope = { kind: 'subtree', imagePath: '/A.app' };
  await writeFile(join(ownership, 'report.json'), JSON.stringify(report));
  await assert.rejects(auditLocalizationPackage({ ...pkgOptions, input: output }), /Ownership scope mismatch/);
});
