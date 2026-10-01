// Only encrypted blobs and transport.json may leave the sender. No archive extraction.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { checkSpace, fileHash, sha256, treeHashes, writeJson } from './collection-checkpoints.mjs';
import { safeRead } from './inspect-unlocalized-resources.mjs';
import { verifyTransfer, validateTransferFiles } from './package-transfer.mjs';

const hash = /^[a-f0-9]{64}$/;
const recipientPattern = /^age1[0-9a-z]{58}$/;
const reserve = 10 * 1024 ** 3;
const execute = promisify(execFile);
async function runAge(age, args) {
  // Do not propagate subprocess output: decryption failures need no payload/key logging.
  try { await execute(age, args, { timeout: 300000, maxBuffer: 1024 ** 2 }); }
  catch { throw new Error('age operation failed; partial output preserved, no completion receipt'); }
}
async function directory(path) {
  assert.ok((await lstat(path)).isDirectory(), 'Directory cannot be a symlink');
  return realpath(path);
}
async function tool(age, ageSha256) {
  assert.match(ageSha256, hash);
  assert.equal(await fileHash(age), ageSha256, 'age executable hash mismatch');
}
export function validateTransport(index) {
  assert.equal(index.formatVersion, 1); assert.equal(index.kind, 'age-localization-transfer');
  assert.match(index.manifestSha256, hash); assert.match(index.recipient, recipientPattern);
  assert.ok(Array.isArray(index.entries) && index.entries.length <= 20001);
  const plain = Object.create(null), encrypted = { '/': null }, seen = new Set();
  let bytes = 0, plainBytes = 0, manifestFound = false;
  for (const entry of index.entries) {
    assert.equal(typeof entry.path, 'string');
    assert.ok(!seen.has(entry.path), 'Duplicate plaintext path'); seen.add(entry.path);
    if (entry.blob === null) { plain[entry.path] = null; continue; }
    assert.match(entry.blob, /^[0-9]{6}\.age$/);
    assert.ok(!Object.hasOwn(encrypted, entry.blob), 'Duplicate encrypted blob');
    assert.ok(Number.isSafeInteger(entry.bytes) && entry.bytes > 0);
    assert.ok(Number.isSafeInteger(entry.plainBytes) && entry.plainBytes >= 0);
    assert.match(entry.sha256, hash);
    encrypted[entry.blob] = { bytes: entry.bytes, sha256: entry.sha256 };
    bytes += entry.bytes; plainBytes += entry.plainBytes;
    assert.ok(bytes <= 2 * 1024 ** 3 + 64 * 1024 ** 2, 'Encrypted transfer exceeds budget');
    if (entry.path === 'manifest.json') {
      assert.ok(entry.plainBytes <= 8 * 1024 ** 2); manifestFound = true;
    } else plain[entry.path] = { bytes: entry.plainBytes, sha256: '0'.repeat(64) };
  }
  assert.ok(manifestFound, 'Missing encrypted manifest');
  validateTransferFiles(plain);
  return { encrypted, bytes, plainBytes };
}
export async function verifySealed({ input, transportSha256 }) {
  assert.match(transportSha256, hash, 'Pin transport hash from trusted sender/job');
  input = await directory(input);
  const raw = await safeRead(input, 'transport.json');
  assert.ok(raw.length <= 8 * 1024 ** 2);
  assert.equal(sha256(raw), transportSha256, 'Transport manifest hash mismatch');
  const index = JSON.parse(raw), inventory = validateTransport(index);
  const actual = await treeHashes(input); delete actual['transport.json'];
  assert.deepEqual(actual, inventory.encrypted, 'Encrypted files changed, missing or unexpected');
  return { index, ...inventory };
}
export async function sealTransfer({ input, output, manifestSha256, recipient, age, ageSha256, minimumFreeBytes = reserve }) {
  assert.match(recipient, recipientPattern); await tool(age, ageSha256);
  const verified = await verifyTransfer({ input, manifestSha256 });
  input = await directory(input); output = resolve(output);
  assert.ok(output !== input && !output.startsWith(input + '/'));
  await checkSpace(dirname(output), minimumFreeBytes + verified.payloadBytes + 64 * 1024 ** 2);
  await mkdir(output, { mode: 0o700 });
  const original = await treeHashes(input), entries = [];
  for (const [path, value] of Object.entries(original)) {
    if (value === null) { entries.push({ path, blob: null }); continue; }
    const blob = String(entries.length).padStart(6, '0') + '.age', dest = join(output, blob);
    await runAge(age, ['--encrypt', '-r', recipient, '-o', dest, join(input, path)]);
    entries.push({ path, blob, plainBytes: value.bytes, bytes: (await lstat(dest)).size, sha256: await fileHash(dest) });
  }
  assert.deepEqual(await treeHashes(input), original, 'Input changed during encryption');
  const index = { formatVersion: 1, kind: 'age-localization-transfer', recipient, manifestSha256, entries };
  validateTransport(index);
  await writeJson(join(output, 'transport.json'), index);
  const transportSha256 = await fileHash(join(output, 'transport.json'));
  const checked = await verifySealed({ input: output, transportSha256 });
  return { status: 'encrypted-transfer-verified', transportSha256, manifestSha256, encryptedBytes: checked.bytes, recipient };
}
export async function unsealTransfer({ input, output, transportSha256, identity, age, ageSha256, minimumFreeBytes = reserve }) {
  await tool(age, ageSha256);
  const key = await lstat(identity);
  assert.ok(key.isFile() && (key.mode & 0o077) === 0, 'Identity must be a private regular file');
  const { index, plainBytes } = await verifySealed({ input, transportSha256 });
  input = await directory(input); output = resolve(output);
  assert.ok(output !== input && !output.startsWith(input + '/'));
  await checkSpace(dirname(output), minimumFreeBytes + plainBytes);
  await mkdir(output, { mode: 0o700 });
  for (const entry of index.entries) {
    if (entry.path === '/') continue;
    const dest = join(output, entry.path);
    if (entry.blob === null) { await mkdir(dest, { recursive: true, mode: 0o700 }); continue; }
    await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
    await runAge(age, ['--decrypt', '-i', identity, '-o', dest, join(input, entry.blob)]);
    assert.equal((await lstat(dest)).size, entry.plainBytes, 'Decrypted size mismatch');
  }
  await verifySealed({ input, transportSha256 });
  return verifyTransfer({ input: output, manifestSha256: index.manifestSha256 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({ options: Object.fromEntries(['mode', 'input', 'output', 'sha256', 'recipient', 'identity', 'age', 'age-sha256'].map(name => [name, { type: 'string' }])) });
  assert.ok(v.input && v.output && ['seal', 'unseal'].includes(v.mode));
  const result = await (v.mode === 'seal' ? sealTransfer : unsealTransfer)({ input: v.input, output: v.output, manifestSha256: v.sha256, transportSha256: v.sha256, recipient: v.recipient, identity: v.identity, age: v.age, ageSha256: v['age-sha256'] });
  console.log(JSON.stringify(result, null, 2));
}
