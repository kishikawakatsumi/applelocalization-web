// v2 keeps quarantined originals for review; v1 remains readable without weakening its checks.
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
const retentions = { 1: 'parsed-data-and-provenance-no-originals-v1', 2: 'parsed-data-and-quarantined-originals-v2' };
const omittedPath = p => p === 'package/quarantine/' || p.startsWith('package/quarantine/');
const readJson = async (root, name) => JSON.parse(await safeRead(root, name));
function partition(files, version) {
  validateTransferFiles(files); // Only known intermediate files can be retained.
  const originals = Object.fromEntries(Object.entries(files).filter(([p, v]) => omittedPath(p) && v !== null));
  return { retained: version === 2 ? { ...files } : Object.fromEntries(Object.entries(files).filter(([p]) => !omittedPath(p))),
    omitted: version === 2 ? {} : originals, originals };
}
export async function verifyIntermediateRelease({ input, manifestSha256 }) {
  assert.match(manifestSha256, hash);
  assert.ok((await lstat(input)).isDirectory(), 'Release root cannot be a symlink'); input = await realpath(input);
  const bytes = await safeRead(input, 'release.json'); assert.ok(bytes.length <= 8 * 1024 ** 2);
  assert.equal(sha256(bytes), manifestSha256, 'Release manifest differs');
  const manifest = JSON.parse(bytes);
  const version = manifest.formatVersion;
  assert.ok([1, 2].includes(version)); assert.equal(manifest.kind, 'localization-intermediate-release');
  assert.equal(manifest.retention, retentions[version]); assert.equal(manifest.originalsRetained, version === 2);
  if (version === 2) { assert.equal(manifest.originalScope, 'quarantined-resources-only'); assert.equal(manifest.sourceImagesRetained, false); }
  const parentBytes = await safeRead(input, origin);
  assert.equal(sha256(parentBytes), manifest.parentTransferSha256, 'Source manifest differs');
  const parent = JSON.parse(parentBytes);
  assert.equal(parent.kind, 'audited-localization-transfer'); assert.equal(parent.formatVersion, 1);
  assert.equal(validateTransferFiles(parent.files), parent.payloadBytes);
  const { retained, omitted, originals } = partition(parent.files, version);
  retained[origin] = { bytes: parentBytes.length, sha256: sha256(parentBytes) };
  assert.deepEqual(manifest.files, retained, 'Release inventory differs from audited source projection');
  assert.deepEqual(manifest.omittedOriginals, omitted, 'Omitted original inventory differs');
  if (version === 2) assert.deepEqual(manifest.retainedOriginals, originals, 'Retained original inventory differs');
  const actual = await treeHashes(input); delete actual['release.json'];
  assert.deepEqual(actual, retained, 'Release bytes changed, missing or unexpected');
  // Check source receipt links using their full inventory. Omitted bytes are NOT checked or claimed present.
  const evidence = await verifyEvidence(input, parent.files);
  assert.equal(manifest.sourceId, evidence.sourceId); assert.equal(parent.sourceId, evidence.sourceId);
  assert.deepEqual(manifest.counts, evidence.counts);
  return { status: version === 1 ? 'parsed-intermediate-release-verified' : 'intermediate-with-quarantine-verified', sourceId: evidence.sourceId, counts: evidence.counts,
    manifestSha256, parentTransferSha256: manifest.parentTransferSha256, originalsRetained: version === 2,
    ...(version === 2 ? { releaseFormatVersion: 2, originalScope: manifest.originalScope, sourceImagesRetained: false,
      retainedOriginalFiles: Object.keys(originals).length, retainedOriginalBytes: Object.values(originals).reduce((s, v) => s + v.bytes, 0) } : {}),
    omittedOriginalFiles: Object.keys(omitted).length, retainedBytes: Object.values(retained).reduce((s, v) => s + (v?.bytes ?? 0), 0),
    auditScope: version === 1 ? 'Retained bytes match a previously audited source; omitted originals are described, not reverified.'
      : 'Parsed streams and every quarantined original match the audited source; source images are not retained.' };
}
export async function exportIntermediateRelease({ input, output, manifestSha256, provenance, minimumFreeBytes = reserve, formatVersion = 2 }) {
  assert.ok([1, 2].includes(formatVersion));
  const verified = await verifyTransfer({ input, manifestSha256 });
  assert.ok(provenance && typeof provenance === 'object');
  assert.match(provenance.collectorCommit, /^[a-f0-9]{40}$/);
  input = await realpath(input); output = resolve(output);
  assert.ok(output !== input && !output.startsWith(input + '/'));
  const parent = await readJson(input, 'manifest.json'), { retained, omitted, originals } = partition(parent.files, formatVersion);
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
  await writeJson(join(output, 'release.json'), { formatVersion, kind: 'localization-intermediate-release', retention: retentions[formatVersion],
    sourceId: verified.sourceId, counts: verified.counts, originalsRetained: formatVersion === 2, parentTransferSha256: manifestSha256,
    ...(formatVersion === 2 ? { originalScope: 'quarantined-resources-only', sourceImagesRetained: false, retainedOriginals: originals } : {}),
    files: retained, omittedOriginals: omitted, provenance,
    limitations: formatVersion === 1 ? ['Not a complete v1/v2 occurrence package: use an explicit no-originals-aware consumer.',
      'Parsed values and all recorded contexts are retained unchanged; unparsed source contents are not retained.',
      'Originals must be reacquired to fix extraction or parse omitted resources; future upstream availability is not guaranteed.',
      'No DB import or web publication. Source audit receipts describe the full pre-projection package.'] : [
      'All quarantined resource originals are retained conservatively for review, including any later supplemented files.',
      'Unresolved does not mean unnecessary. No resource is automatically discarded after successful parsing or review.',
      'No IPSW, installer, DMG, keys or normally parsed resource originals. Repairs outside quarantine still require source reacquisition.',
      'No DB import or web publication. Parsed streams, context and original audit receipts are unchanged.'] });
  return verifyIntermediateRelease({ input: output, manifestSha256: await fileHash(join(output, 'release.json')) });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({ options: Object.fromEntries(['input', 'sha256'].map(k => [k, { type: 'string' }])) });
  console.log(JSON.stringify(await verifyIntermediateRelease({ input: v.input, manifestSha256: v.sha256 }), null, 2));
}
