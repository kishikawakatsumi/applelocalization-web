// Storage-neutral, directory-based transfer. No network, DB, archive extraction or publication.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { checkSpace, fileHash, sha256, treeHashes, writeJson } from './collection-checkpoints.mjs';
import { safeRead } from './inspect-unlocalized-resources.mjs';

const hashPattern = /^[a-f0-9]{64}$/;
const streams = ['sources', 'resources', 'tables', 'occurrences', 'issues', 'symlinks'];
const limit = 2 * 1024 ** 3;
const reserve = 10 * 1024 ** 3;
const json = async (root, name) => JSON.parse(await safeRead(root, name));
async function directory(path) {
  assert.ok((await lstat(path)).isDirectory(), 'Directory must not be a symlink');
  return realpath(path);
}
const allowedPackage = name => ['report.json', 'catalog.json', ...streams.map(s => s + '.jsonl.gz')].includes(name)
  || /^quarantine\/[a-f0-9]{64}\.(strings|stringsdict|loctable)$/.test(name);

export function validateTransferFiles(files) {
  assert.ok(files && typeof files === 'object' && !Array.isArray(files));
  assert.ok(Object.keys(files).length <= 20000, 'Too many transfer entries');
  let bytes = 0;
  for (const [name, value] of Object.entries(files)) {
    if (value === null) {
      assert.ok(['/', 'package/', 'package/quarantine/', 'evidence/'].includes(name), 'Unexpected directory');
      continue;
    }
    assert.ok((name.startsWith('package/') && allowedPackage(name.slice(8))) ||
      ['evidence/package.complete.json', 'evidence/package-audit.complete.json', 'evidence/audit.json'].includes(name), 'Unexpected transfer file');
    assert.ok(Number.isSafeInteger(value.bytes) && value.bytes >= 0);
    assert.match(value.sha256, hashPattern); bytes += value.bytes;
    assert.ok(bytes <= limit, 'Transfer exceeds 2 GiB budget');
  }
  for (const name of ['package/report.json', 'package/catalog.json', ...streams.map(s => `package/${s}.jsonl.gz`),
    'evidence/package.complete.json', 'evidence/package-audit.complete.json', 'evidence/audit.json']) assert.ok(files[name], `Missing ${name}`);
  return bytes;
}

// Receiver validates that the byte-identical package is the one sealed by the audit.
// This verifies an existing audit receipt, not a fresh original-image/content audit.
export async function verifyEvidence(root, files) {
  const packageReceipt = await json(root, 'evidence/package.complete.json');
  const auditReceipt = await json(root, 'evidence/package-audit.complete.json');
  assert.equal(packageReceipt.stage, 'package'); assert.equal(auditReceipt.stage, 'package-audit');
  assert.equal(auditReceipt.dependencies.package, files['evidence/package.complete.json'].sha256, 'Audit does not bind package receipt');
  const { package: _package, ...otherDependencies } = auditReceipt.dependencies;
  assert.deepEqual(otherDependencies, packageReceipt.dependencies, 'Upstream receipts differ');
  const packageTree = { '/': null };
  for (const [name, value] of Object.entries(files)) if (name.startsWith('package/')) packageTree['data/' + name.slice(8)] = value;
  assert.deepEqual(packageReceipt.files, packageTree, 'Package differs from audited checkpoint');
  assert.deepEqual(auditReceipt.files, { '/': null, 'report.json': files['evidence/audit.json'] }, 'Audit report differs from checkpoint');
  const report = await json(root, 'package/report.json'), audit = await json(root, 'evidence/audit.json');
  assert.equal(report.outputKind, 'localization-occurrence-package');
  assert.ok([1, 2].includes(report.formatVersion));
  assert.equal(report.status, 'prepared-not-imported'); assert.equal(audit.status, 'package-content-verified');
  assert.equal(report.sourceId, audit.sourceId); assert.deepEqual(report.counts, audit.counts);
  assert.equal(report.catalogSha256, files['package/catalog.json'].sha256);
  for (const name of streams) assert.equal(report.outputHashes[name], files[`package/${name}.jsonl.gz`].sha256, 'Compressed stream hash mismatch');
  const binaries = Object.fromEntries(Object.entries(files).filter(([name, value]) => value && name.startsWith('package/quarantine/')).map(([name, value]) => [name.slice(8), value.sha256]));
  assert.deepEqual(report.binaryHashes, binaries, 'Quarantine inventory differs');
  return { sourceId: report.sourceId, counts: report.counts, audit: audit.status };
}

async function copyTree(input, output, files) {
  for (const [name, value] of Object.entries(files)) {
    if (name === '/') continue;
    const dest = join(output, name);
    if (value === null) await mkdir(dest, { recursive: true, mode: 0o700 });
    else {
      await mkdir(dirname(dest), { recursive: true, mode: 0o700 });
      assert.ok((await lstat(join(input, name))).isFile(), 'Source ceased to be regular');
      await copyFile(join(input, name), dest, constants.COPYFILE_EXCL);
    }
  }
}

export async function verifyTransfer({ input, manifestSha256 }) {
  assert.match(manifestSha256, hashPattern, 'Pin the manifest hash from a trusted sender');
  input = await directory(input);
  const bytes = await safeRead(input, 'manifest.json');
  assert.ok(bytes.length <= 8 * 1024 ** 2, 'Manifest too large');
  assert.equal(sha256(bytes), manifestSha256, 'Transfer manifest hash mismatch');
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.formatVersion, 1); assert.equal(manifest.kind, 'audited-localization-transfer');
  const totalBytes = validateTransferFiles(manifest.files);
  const actual = await treeHashes(input); delete actual['manifest.json'];
  assert.deepEqual(actual, manifest.files, 'Transfer files changed, missing or unexpected');
  const evidence = await verifyEvidence(input, actual);
  assert.equal(evidence.sourceId, manifest.sourceId); assert.equal(totalBytes, manifest.payloadBytes);
  return { status: 'audited-package-transfer-verified', manifestSha256, payloadBytes: totalBytes, ...evidence };
}

export async function exportTransfer({ collection, output, minimumFreeBytes = reserve }) {
  collection = await directory(collection);
  output = resolve(output);
  assert.ok(output !== collection && !output.startsWith(collection + '/'), 'Keep export outside collection');
  const pack = await json(collection, 'package.complete.json'), audit = await json(collection, 'package-audit.complete.json');
  assert.match(pack.attempt, /^package-attempt-[0-9]{4,}$/);
  assert.match(audit.attempt, /^package-audit-attempt-[0-9]{4,}$/);
  assert.deepEqual(await treeHashes(join(collection, pack.attempt)), pack.files, 'Package checkpoint changed');
  assert.deepEqual(await treeHashes(join(collection, audit.attempt)), audit.files, 'Audit checkpoint changed');
  const packageRoot = join(collection, pack.attempt, 'data');
  const files = { '/': null, 'package/': null, 'evidence/': null };
  for (const [name, value] of Object.entries(await treeHashes(packageRoot))) if (name !== '/') files['package/' + name] = value;
  const evidence = { 'package.complete.json': 'package.complete.json', 'package-audit.complete.json': 'package-audit.complete.json', 'audit.json': audit.attempt + '/report.json' };
  for (const [name, source] of Object.entries(evidence)) {
    const raw = await safeRead(collection, source);
    files['evidence/' + name] = { bytes: raw.length, sha256: sha256(raw) };
  }
  const total = validateTransferFiles(files);
  await checkSpace(dirname(output), minimumFreeBytes + total);
  await mkdir(output, { mode: 0o700 });
  await mkdir(join(output, 'package'), { mode: 0o700 });
  await mkdir(join(output, 'evidence'), { mode: 0o700 });
  await copyTree(packageRoot, join(output, 'package'), await treeHashes(packageRoot));
  for (const [name, source] of Object.entries(evidence)) await copyFile(join(collection, source), join(output, 'evidence', name), constants.COPYFILE_EXCL);
  assert.deepEqual(await treeHashes(output), files, 'Source changed during export');
  const checked = await verifyEvidence(output, files);
  await writeJson(join(output, 'manifest.json'), { formatVersion: 1, kind: 'audited-localization-transfer', sourceId: checked.sourceId, payloadBytes: total, files,
    limitations: ['SHA-256 binds transfer bytes to an existing audit receipt, not an independent original-image audit or publisher signature.', 'No DB import or publication authorization. A trusted manifest hash must be supplied separately.'] });
  return verifyTransfer({ input: output, manifestSha256: await fileHash(join(output, 'manifest.json')) });
}

export async function receiveTransfer({ input, output, manifestSha256, minimumFreeBytes = reserve }) {
  const verified = await verifyTransfer({ input, manifestSha256 });
  input = await directory(input); output = resolve(output);
  assert.ok(output !== input && !output.startsWith(input + '/'), 'Keep receipt outside transfer');
  await checkSpace(dirname(output), minimumFreeBytes + verified.payloadBytes + 8 * 1024 ** 2);
  await mkdir(output, { mode: 0o700 });
  const payload = join(output, 'payload'); await mkdir(payload, { mode: 0o700 });
  await copyTree(input, payload, await treeHashes(input));
  const final = await verifyTransfer({ input: payload, manifestSha256 });
  // Created LAST. A partial receive without this receipt is not ready for consumers.
  const receipt = { ...final, status: 'received-package-verified-not-imported', receivedAt: new Date().toISOString(), imported: false, published: false };
  await writeJson(join(output, 'receipt.json'), receipt);
  return receipt;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { mode: { type: 'string' }, input: { type: 'string' }, output: { type: 'string' }, sha256: { type: 'string' } } });
  assert.ok(values.input && ['export', 'verify', 'receive'].includes(values.mode), '--mode export|verify|receive and --input required');
  if (values.mode !== 'verify') assert.ok(values.output, '--output required');
  const result = values.mode === 'export' ? await exportTransfer({ collection: values.input, output: values.output })
    : await (values.mode === 'verify' ? verifyTransfer : receiveTransfer)({ input: values.input, output: values.output, manifestSha256: values.sha256 });
  console.log(JSON.stringify(result, null, 2));
}
