import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, symlink, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectionStages } from '../../scripts/collection/collect-image-localizations.mjs';
import { runCheckpoints, withCollectionLock } from '../../scripts/shared/collection-checkpoints.mjs';
import { exportTransfer, verifyTransfer, receiveTransfer, validateTransferFiles } from '../../scripts/package/package-transfer.mjs';

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), 'transfer-test-')), root = join(temp, 'image'), collection = join(temp, 'collection');
  for (const language of ['en', 'ja']) {
    const dir = join(root, 'Demo.app', language + '.lproj'); await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'Localizable.strings'), JSON.stringify({ Open: language === 'ja' ? '開く' : 'Open', plural: { one: '1', other: '%d' } }));
  }
  await writeFile(join(root, 'Demo.app', 'Unknown.strings'), JSON.stringify({ key: 'Do not guess language' }));
  await withCollectionLock(collection, () => runCheckpoints({ output: collection, identity: { source: 'fixture' }, minimumFreeBytes: 0,
    stages: collectionStages({ root, label: 'fixture', minimumFreeBytes: 0, extractionOptions: { requireReadOnlyMount: false, decode: bytes => JSON.parse(bytes) } }) }));
  return { temp, collection, output: join(temp, 'transfer') };
}
test('audited transfer preserves all package bytes and writes receipt only after receiver verification', async () => {
  const f = await fixture(), exported = await exportTransfer({ ...f, minimumFreeBytes: 0 });
  assert.equal(exported.counts.occurrences, 4); assert.equal(exported.counts.quarantinedFiles, 1);
  const before = await readFile(join(f.output, 'package', 'occurrences.jsonl.gz'));
  const saved = join(f.temp, 'saved');
  const received = await receiveTransfer({ input: f.output, output: saved, manifestSha256: exported.manifestSha256, minimumFreeBytes: 0 });
  assert.equal(received.status, 'received-package-verified-not-imported');
  assert.deepEqual(await readFile(join(saved, 'payload', 'package', 'occurrences.jsonl.gz')), before);
  assert.equal(JSON.parse(await readFile(join(saved, 'receipt.json'))).manifestSha256, exported.manifestSha256);
  await assert.rejects(receiveTransfer({ input: f.output, output: saved, manifestSha256: exported.manifestSha256, minimumFreeBytes: 0 }), /EEXIST/);
});
test('missing audit or changed source never becomes an export', async () => {
  const f = await fixture();
  await writeFile(join(f.collection, 'package-attempt-0001/data/catalog.json'), '{}');
  await assert.rejects(exportTransfer({ ...f, minimumFreeBytes: 0 }), /checkpoint changed/);
  await assert.rejects(readFile(join(f.output, 'manifest.json')), /ENOENT/);
});
test('receiver rejects wrong manifest, extra files, changed bytes, missing files and symlinks', async () => {
  const f = await fixture(), exported = await exportTransfer({ ...f, minimumFreeBytes: 0 });
  const verify = () => verifyTransfer({ input: f.output, manifestSha256: exported.manifestSha256 });
  await assert.rejects(verifyTransfer({ input: f.output, manifestSha256: '0'.repeat(64) }), /manifest hash/);
  const extra = join(f.output, 'secret.pem'); await writeFile(extra, 'not exported');
  await assert.rejects(verify(), /unexpected/); await unlink(extra);
  const catalog = join(f.output, 'package/catalog.json'), bytes = await readFile(catalog);
  await writeFile(catalog, '{}'); await assert.rejects(verify(), /changed/);
  await unlink(catalog); await assert.rejects(verify(), /missing/);
  const outside = join(f.temp, 'outside'); await writeFile(outside, bytes); await symlink(outside, catalog);
  await assert.rejects(verify(), /Unsupported/);
});
test('manifest allowlist refuses traversal, images, keys and oversized transfers', () => {
  for (const name of ['../outside', 'package/../secret', 'package/image.dmg', 'evidence/private.key']) assert.throws(() => validateTransferFiles({ [name]: { bytes: 1, sha256: 'a'.repeat(64) } }));
  assert.throws(() => validateTransferFiles({ 'package/occurrences.jsonl.gz': { bytes: 3 * 1024 ** 3, sha256: 'a'.repeat(64) } }), /budget/);
});
