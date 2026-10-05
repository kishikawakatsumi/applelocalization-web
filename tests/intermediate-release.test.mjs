import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, copyFile, unlink, symlink, access } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectionStages } from '../scripts/collect-image-localizations.mjs';
import { runCheckpoints, withCollectionLock, fileHash, treeHashes, writeJson } from '../scripts/collection-checkpoints.mjs';
import { exportTransfer, verifyTransfer } from '../scripts/package-transfer.mjs';
import { exportIntermediateRelease, verifyIntermediateRelease } from '../scripts/intermediate-release.mjs';
import { verifyReleaseAssets } from '../scripts/verify-release-assets.mjs';
import { publishIntermediateRelease } from '../scripts/publish-intermediate-release.mjs';
import { writeIntermediateAssets } from '../scripts/intermediate-assets.mjs';
import { prepareDurableReleaseSQL } from '../scripts/release-durable-sql.mjs';
import { auditOccurrenceSQL } from '../scripts/audit-occurrence-sql.mjs';

async function fixture(version = 1, unknown = true) {
  const temp = await mkdtemp(join(tmpdir(), 'intermediate-release-')), root = join(temp, 'image'), collection = join(temp, 'collection');
  for (const [bundle, ja] of [['One.app', '開く'], ['Two.app', '営業中']]) for (const lang of ['en', 'ja']) {
    const dir = join(root, bundle, lang + '.lproj'); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'Localizable.strings'), JSON.stringify({ key: lang === 'en' ? 'Open' : ja, plural: { one: '1', other: '%d' }, blank: '', nul: '\u0000' }));
  }
  if (unknown) await writeFile(join(root, 'One.app', 'Unknown.strings'), '{"unparsed":"retain metadata but not this file"}');
  await withCollectionLock(collection, () => runCheckpoints({ output: collection, identity: { source: 'fixture' }, minimumFreeBytes: 0,
    stages: collectionStages({ root, label: 'fixture', minimumFreeBytes: 0, extractionOptions: { requireReadOnlyMount: false, decode: b => JSON.parse(b) } }) }));
  const input = join(temp, 'transfer'), source = await exportTransfer({ collection, output: input, minimumFreeBytes: 0 });
  const output = join(temp, 'release'), provenance = { collectorCommit: 'a'.repeat(40) };
  const result = await exportIntermediateRelease({ input, output, manifestSha256: source.manifestSha256, provenance, minimumFreeBytes: 0, ...(version === 1 ? { formatVersion: 1 } : {}) });
  return { temp, input, output, source, result, provenance };
}
test('parsed release preserves every parsed byte and context while explicitly omitting original files', async () => {
  const f = await fixture();
  assert.equal(f.result.counts.occurrences, 16); assert.equal(f.result.omittedOriginalFiles, 1);
  const files = await treeHashes(f.output);
  assert.ok(!Object.keys(files).some(p => p.includes('quarantine')));
  for (const name of ['occurrences', 'resources', 'sources', 'tables', 'issues', 'symlinks']) assert.equal(await fileHash(join(f.output, `package/${name}.jsonl.gz`)), await fileHash(join(f.input, `package/${name}.jsonl.gz`)));
  assert.equal(await fileHash(join(f.output, 'package/report.json')), await fileHash(join(f.input, 'package/report.json')));
  await verifyTransfer({ input: f.input, manifestSha256: f.source.manifestSha256 }); // Original untouched.
  await assert.rejects(exportIntermediateRelease({ input: f.input, output: f.output, manifestSha256: f.source.manifestSha256, provenance: f.provenance, minimumFreeBytes: 0 }), /EEXIST/);
});
test('release verifier rejects raw extras, omissions, damaged retained data and forged omission inventories', async () => {
  const f = await fixture(), verify = () => verifyIntermediateRelease({ input: f.output, manifestSha256: f.result.manifestSha256 });
  const raw = join(f.output, 'original.strings'); await writeFile(raw, '{}'); await assert.rejects(verify(), /unexpected/); await unlink(raw);
  const retained = join(f.output, 'package/report.json'), original = await readFile(retained);
  await writeFile(retained, '{}'); await assert.rejects(verify(), /changed/);
  await unlink(retained); await assert.rejects(verify(), /missing/);
  await writeFile(retained, original); await verify();
  const p = join(f.output, 'release.json'), m = JSON.parse(await readFile(p)); m.omittedOriginals = {};
  await writeFile(p, JSON.stringify(m));
  await assert.rejects(verifyIntermediateRelease({ input: f.output, manifestSha256: await fileHash(p) }), /Omitted original inventory/);
});
test('acquisition and publication require explicit public-data approval before any side effect', async () => {
  await assert.rejects(publishIntermediateRelease({}), /public parsed-data approval/);
  await assert.rejects(publishIntermediateRelease({ allowPublicData: true, publishMigration: true }), /requires original producer pins/);
});
test('release assets verify archive and extracted inventory, refusing altered assets', async () => {
  const f = await fixture(), assets = join(f.temp, 'assets'); await mkdir(assets);
  const archive = join(assets, 'localization-intermediate.tar');
  await promisify(execFile)('/usr/bin/tar', ['-cf', archive, '-C', f.output, 'release.json', 'package', 'evidence']);
  const { lstat } = await import('node:fs/promises');
  await writeJson(join(assets, 'artifact.json'), { formatVersion: 1, kind: 'localization-intermediate-release-artifact', archive: { name: 'localization-intermediate.tar', bytes: (await lstat(archive)).size, sha256: await fileHash(archive) }, ...f.result, provenance: f.provenance, imported: false, publishedToWeb: false });
  const artifactSha256 = await fileHash(join(assets, 'artifact.json'));
  await verifyReleaseAssets({ input: assets, output: join(f.temp, 'unpacked'), artifactSha256 });
  await copyFile(join(assets, 'artifact.json'), join(assets, 'extra'));
  await assert.rejects(verifyReleaseAssets({ input: assets, output: join(f.temp, 'bad'), artifactSha256 }));
});
test('archive reader rejects raw paths, duplicates and symlinks before creating output', async () => {
  const temp = await mkdtemp(join(tmpdir(), 'intermediate-unsafe-tar-')), source = join(temp, 'source');
  await mkdir(source);
  await writeFile(join(source, 'original.strings'), '{}');
  await writeFile(join(source, 'release.json'), '{}');
  const run = promisify(execFile), reader = fileURLToPath(new URL('../scripts/unpack-intermediate-release.py', import.meta.url));
  for (const [name, paths] of [['raw', ['original.strings']], ['duplicate', ['release.json', 'release.json']], ['link', ['release.json']]]) {
    if (name === 'link') { await unlink(join(source, 'release.json')); await symlink('original.strings', join(source, 'release.json')); }
    const archive = join(temp, name + '.tar'), output = join(temp, name);
    await run('/usr/bin/tar', ['-cf', archive, '-C', source, ...paths]);
    await assert.rejects(run('python3', [reader, '--archive', archive, '--output', output]), /Unexpected tar path\/type|Duplicate tar member/);
    await assert.rejects(access(output), /ENOENT/);
  }
});
test('v2 defaults to preserving every quarantine byte and context and rejects missing, changed or unlisted originals', async () => {
  const f = await fixture(2), manifest = JSON.parse(await readFile(join(f.output, 'release.json')));
  assert.equal(manifest.formatVersion, 2); assert.equal(f.result.originalsRetained, true);
  assert.equal(f.result.retainedOriginalFiles, 1); assert.equal(f.result.omittedOriginalFiles, 0);
  assert.equal(f.result.sourceImagesRetained, false);
  for (const name of ['occurrences', 'resources', 'sources', 'tables', 'issues', 'symlinks']) assert.equal(await fileHash(join(f.output, `package/${name}.jsonl.gz`)), await fileHash(join(f.input, `package/${name}.jsonl.gz`)));
  const name = Object.keys(manifest.retainedOriginals)[0], path = join(f.output, name), bytes = await readFile(path);
  assert.deepEqual(bytes, await readFile(join(f.input, name)));
  const assets = join(f.temp, 'assets-v2');
  const packaged = await writeIntermediateAssets({ input: f.output, output: assets, manifestSha256: f.result.manifestSha256 });
  const checked = await verifyReleaseAssets({ input: assets, output: join(f.temp, 'unpacked-v2'), artifactSha256: packaged.artifactSha256 });
  assert.equal(checked.retainedOriginalFiles, 1);
  assert.deepEqual(await readFile(join(f.temp, 'unpacked-v2', name)), bytes);
  const verify = () => verifyIntermediateRelease({ input: f.output, manifestSha256: f.result.manifestSha256 });
  await unlink(path); await assert.rejects(verify(), /missing/);
  await writeFile(path, 'corrupted'); await assert.rejects(verify(), /changed/);
  await writeFile(path, bytes);
  const extra = join(f.output, 'package/quarantine', 'f'.repeat(64) + '.strings');
  await writeFile(extra, '{}'); await assert.rejects(verify(), /unexpected/); await unlink(extra);
  manifest.retainedOriginals = {}; await writeFile(join(f.output, 'release.json'), JSON.stringify(manifest));
  await assert.rejects(verifyIntermediateRelease({ input: f.output, manifestSha256: await fileHash(join(f.output, 'release.json')) }), /Retained original inventory/);
});
test('v2 also handles an empty quarantine without inventing original files', async () => {
  const f = await fixture(2, false), assets = join(f.temp, 'empty-quarantine-assets');
  assert.equal(f.result.retainedOriginalFiles, 0); assert.equal(f.result.retainedOriginalBytes, 0);
  const built = await writeIntermediateAssets({ input: f.output, output: assets, manifestSha256: f.result.manifestSha256 });
  await verifyReleaseAssets({ input: assets, output: join(f.temp, 'empty-quarantine-verified'), artifactSha256: built.artifactSha256 });
});


test('durable release SQL keeps every value and quarantine byte but is never accepted as staging SQL', async () => {
  const f = await fixture(2), output = join(f.temp, 'durable');
  const result = await prepareDurableReleaseSQL({ input: f.output, output, manifestSha256: f.result.manifestSha256,
    schema: 'localization_fixture', database: 'localization_staging', minimumFreeBytes: 0 });
  assert.equal(result.status, 'durable-release-sql-verified-not-imported'); assert.equal(result.storage, 'logged');
  assert.equal(result.stats.rows, 16); assert.equal(result.quarantinedFiles, 1);
  assert.equal(result.apiCompatible, false); assert.equal(result.productionReady, false);
  await assert.rejects(auditOccurrenceSQL({ input: join(f.output, 'package'), sql: output, packageManifest: result.packageManifest }), /durable-occurrence-sql-prepared/);
});
