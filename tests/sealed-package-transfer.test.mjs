import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile, readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectionStages } from '../scripts/collect-image-localizations.mjs';
import { fileHash, runCheckpoints, withCollectionLock } from '../scripts/collection-checkpoints.mjs';
import { exportTransfer, receiveTransfer } from '../scripts/package-transfer.mjs';
import { sealTransfer, unsealTransfer, verifySealed, validateTransport } from '../scripts/sealed-package-transfer.mjs';

const paths = ['manifest.json', 'package/report.json', 'package/catalog.json', ...['sources', 'resources', 'tables', 'occurrences', 'issues', 'symlinks'].map(n => `package/${n}.jsonl.gz`), 'evidence/package.complete.json', 'evidence/package-audit.complete.json', 'evidence/audit.json'];
function index() {
  return { formatVersion: 1, kind: 'age-localization-transfer', recipient: 'age1' + 'a'.repeat(58), manifestSha256: 'a'.repeat(64), entries: paths.map((path, i) => ({ path, blob: String(i).padStart(6, '0') + '.age', bytes: 300, plainBytes: 1, sha256: 'b'.repeat(64) })) };
}
test('encrypted index rejects traversal, duplicate paths/blobs, keys, images, prototype keys and size overruns', () => {
  assert.equal(validateTransport(index()).bytes, 3600);
  for (const path of ['../escape', '/tmp/escape', 'package/../escape', '__proto__', 'constructor', 'image.dmg', 'identity.txt']) {
    for (const blob of [null, '000100.age']) {
      const i = index(); i.entries.push({ path, blob, bytes: 300, plainBytes: 1, sha256: 'b'.repeat(64) });
      assert.throws(() => validateTransport(i));
    }
  }
  for (const mutate of [i => i.entries.push(i.entries[0]), i => i.entries[1].blob = i.entries[0].blob, i => i.entries[0].blob = '../escape.age', i => i.entries[0].bytes = 3 * 1024 ** 3, i => i.entries[0].plainBytes = 9 * 1024 ** 2, i => i.entries.shift()]) {
    const i = index(); mutate(i); assert.throws(() => validateTransport(i));
  }
});

test('real age roundtrip, wrong key, tampering, missing/extra blobs and exclusive destinations', { skip: !process.env.TEST_AGE || !process.env.TEST_AGE_KEYGEN }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'sealed-transfer-test-')), root = join(temp, 'image'), collection = join(temp, 'collection');
  const dir = join(root, 'Demo.app/en.lproj'); await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'Localizable.strings'), JSON.stringify({ Open: 'Open' }));
  await withCollectionLock(collection, () => runCheckpoints({ output: collection, identity: { source: 'fixture' }, minimumFreeBytes: 0,
    stages: collectionStages({ root, label: 'fixture', minimumFreeBytes: 0, extractionOptions: { requireReadOnlyMount: false, decode: bytes => JSON.parse(bytes) } }) }));
  const input = join(temp, 'transfer'), exported = await exportTransfer({ collection, output: input, minimumFreeBytes: 0 });
  const run = promisify(execFile), identity = join(temp, 'identity.txt'), wrong = join(temp, 'wrong.txt');
  await run(process.env.TEST_AGE_KEYGEN, ['-o', identity]); await run(process.env.TEST_AGE_KEYGEN, ['-o', wrong]);
  const recipient = (await run(process.env.TEST_AGE_KEYGEN, ['-y', identity])).stdout.trim();
  const options = { age: process.env.TEST_AGE, ageSha256: await fileHash(process.env.TEST_AGE), minimumFreeBytes: 0 };
  const output = join(temp, 'sealed'), sealed = await sealTransfer({ input, output, recipient, manifestSha256: exported.manifestSha256, ...options });
  const decrypted = join(temp, 'decrypted'), unseal = { input: output, output: decrypted, identity, transportSha256: sealed.transportSha256, ...options };
  await assert.rejects(unsealTransfer({ ...unseal, identity: wrong, output: join(temp, 'wrong-output') }), /age operation failed/);
  await unsealTransfer(unseal);
  await assert.rejects(unsealTransfer(unseal), /EEXIST/);
  const accepted = await receiveTransfer({ input: decrypted, output: join(temp, 'received'), manifestSha256: exported.manifestSha256, minimumFreeBytes: 0 });
  assert.equal(accepted.counts.occurrences, 1); assert.equal(accepted.imported, false);
  const verify = () => verifySealed({ input: output, transportSha256: sealed.transportSha256 });
  await assert.rejects(verifySealed({ input: output, transportSha256: '0'.repeat(64) }), /manifest hash/);
  await writeFile(join(output, 'extra'), 'x'); await assert.rejects(verify(), /unexpected/); await unlink(join(output, 'extra'));
  const transport = JSON.parse(await readFile(join(output, 'transport.json'))), blob = transport.entries.find(e => e.blob).blob;
  await writeFile(join(output, blob), 'changed'); await assert.rejects(verify(), /changed/);
  await unlink(join(output, blob)); await assert.rejects(verify(), /missing/);
});
