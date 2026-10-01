// Derived archive: parsed rows + provenance, deliberately NO quarantined original bytes.
// The old complete package/audit receipts remain unchanged and describe the source, not this archive.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, lstat, mkdir, realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { checkSpace, fileHash, sha256, treeHashes, writeJson } from './collection-checkpoints.mjs';
import { verifyTransfer, validateTransferFiles, verifyEvidence } from './package-transfer.mjs';
import { safeRead } from './inspect-unlocalized-resources.mjs';

const hash = /^[a-f0-9]{64}$/;
const reserve = 10 * 1024 ** 3;
const origin = 'evidence/transfer-manifest.json';
const retention = 'parsed-data-and-provenance-no-originals-v1';
const omittedPath = p => p === 'package/quarantine/' || p.startsWith('package/quarantine/');
const readJson = async (root, name) => JSON.parse(await safeRead(root, name));
function partition(files) {
  validateTransferFiles(files); // Only known intermediate files can be retained.
  return { retained: Object.fromEntries(Object.entries(files).filter(([p]) => !omittedPath(p))),
    omitted: Object.fromEntries(Object.entries(files).filter(([p, v]) => omittedPath(p) && v !== null)) };
}
export async function verifyIntermediateRelease({ input, manifestSha256 }) {
  assert.match(manifestSha256, hash);
  assert.ok((await lstat(input)).isDirectory(), 'Release root cannot be a symlink'); input = await realpath(input);
  const bytes = await safeRead(input, 'release.json'); assert.ok(bytes.length <= 8 * 1024 ** 2);
  assert.equal(sha256(bytes), manifestSha256, 'Release manifest differs');
  const manifest = JSON.parse(bytes);
  assert.equal(manifest.formatVersion, 1); assert.equal(manifest.kind, 'localization-intermediate-release');
  assert.equal(manifest.retention, retention); assert.equal(manifest.originalsRetained, false);
  const parentBytes = await safeRead(input, origin);
  assert.equal(sha256(parentBytes), manifest.parentTransferSha256, 'Source manifest differs');
  const parent = JSON.parse(parentBytes);
  assert.equal(parent.kind, 'audited-localization-transfer'); assert.equal(parent.formatVersion, 1);
  assert.equal(validateTransferFiles(parent.files), parent.payloadBytes);
  const { retained, omitted } = partition(parent.files);
  retained[origin] = { bytes: parentBytes.length, sha256: sha256(parentBytes) };
  assert.deepEqual(manifest.files, retained, 'Release inventory differs from audited source projection');
  assert.deepEqual(manifest.omittedOriginals, omitted, 'Omitted original inventory differs');
  const actual = await treeHashes(input); delete actual['release.json'];
  assert.deepEqual(actual, retained, 'Release bytes changed, missing or unexpected');
  // Check source receipt links using their full inventory. Omitted bytes are NOT checked or claimed present.
  const evidence = await verifyEvidence(input, parent.files);
  assert.equal(manifest.sourceId, evidence.sourceId); assert.equal(parent.sourceId, evidence.sourceId);
  assert.deepEqual(manifest.counts, evidence.counts);
  return { status: 'parsed-intermediate-release-verified', sourceId: evidence.sourceId, counts: evidence.counts,
    manifestSha256, parentTransferSha256: manifest.parentTransferSha256, originalsRetained: false,
    omittedOriginalFiles: Object.keys(omitted).length, retainedBytes: Object.values(retained).reduce((s, v) => s + (v?.bytes ?? 0), 0),
    auditScope: 'Retained bytes match a previously audited source; omitted originals are described, not reverified.' };
}
export async function exportIntermediateRelease({ input, output, manifestSha256, provenance, minimumFreeBytes = reserve }) {
  const verified = await verifyTransfer({ input, manifestSha256 });
  assert.ok(provenance && typeof provenance === 'object');
  assert.match(provenance.collectorCommit, /^[a-f0-9]{40}$/);
  input = await realpath(input); output = resolve(output);
  assert.ok(output !== input && !output.startsWith(input + '/'));
  const parent = await readJson(input, 'manifest.json'), { retained, omitted } = partition(parent.files);
  await checkSpace(dirname(output), minimumFreeBytes + verified.payloadBytes + 16 * 1024 ** 2);
  await mkdir(output, { mode: 0o700 });
  for (const [name, value] of Object.entries(retained)) {
    if (name === '/') continue;
    const dest = join(output, name);
    if (value === null) await mkdir(dest, { recursive: true, mode: 0o700 });
    else { await mkdir(dirname(dest), { recursive: true, mode: 0o700 }); await copyFile(join(input, name), dest, constants.COPYFILE_EXCL); }
  }
  await copyFile(join(input, 'manifest.json'), join(output, origin), constants.COPYFILE_EXCL);
  retained[origin] = { bytes: (await lstat(join(output, origin))).size, sha256: manifestSha256 };
  assert.deepEqual(await treeHashes(output), retained, 'Source changed during projection');
  await writeJson(join(output, 'release.json'), { formatVersion: 1, kind: 'localization-intermediate-release', retention,
    sourceId: verified.sourceId, counts: verified.counts, originalsRetained: false, parentTransferSha256: manifestSha256,
    files: retained, omittedOriginals: omitted, provenance,
    limitations: ['Not a complete v1/v2 occurrence package: use an explicit no-originals-aware consumer.',
      'Parsed values and all recorded contexts are retained unchanged; unparsed source contents are not retained.',
      'Originals must be reacquired to fix extraction or parse omitted resources; future upstream availability is not guaranteed.',
      'No DB import or web publication. Source audit receipts describe the full pre-projection package.'] });
  return verifyIntermediateRelease({ input: output, manifestSha256: await fileHash(join(output, 'release.json')) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({ options: Object.fromEntries(['input', 'sha256'].map(k => [k, { type: 'string' }])) });
  console.log(JSON.stringify(await verifyIntermediateRelease({ input: v.input, manifestSha256: v.sha256 }), null, 2));
}
