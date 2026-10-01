import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { lstat, readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { fileHash } from './collection-checkpoints.mjs';
import { verifyIntermediateRelease } from './intermediate-release.mjs';

export async function verifyReleaseAssets({ input, output, artifactSha256, python = 'python3' }) {
  assert.match(artifactSha256, /^[a-f0-9]{64}$/, 'Pin the artifact metadata hash from a trusted producer');
  assert.ok((await lstat(input)).isDirectory());
  assert.deepEqual((await readdir(input)).sort(), ['artifact.json', 'localization-intermediate.tar']);
  assert.equal(await fileHash(join(input, 'artifact.json')), artifactSha256);
  assert.ok((await lstat(join(input, 'artifact.json'))).size <= 8 * 1024 ** 2);
  const artifact = JSON.parse(await readFile(join(input, 'artifact.json')));
  assert.ok([1, 2].includes(artifact.formatVersion)); assert.equal(artifact.kind, 'localization-intermediate-release-artifact');
  assert.equal(artifact.originalsRetained, artifact.formatVersion === 2); assert.equal(artifact.imported, false); assert.equal(artifact.publishedToWeb, false);
  assert.equal(artifact.archive.name, 'localization-intermediate.tar');
  const archive = join(input, artifact.archive.name);
  assert.ok(Number.isSafeInteger(artifact.archive.bytes) && artifact.archive.bytes > 0 && artifact.archive.bytes < 2 * 1024 ** 3);
  assert.equal((await lstat(archive)).size, artifact.archive.bytes); assert.equal(await fileHash(archive), artifact.archive.sha256);
  await promisify(execFile)(python, [fileURLToPath(new URL('./unpack-intermediate-release.py', import.meta.url)), '--archive', archive, '--output', resolve(output)], { timeout: 300000 });
  const checked = await verifyIntermediateRelease({ input: output, manifestSha256: artifact.manifestSha256 });
  for (const name of ['sourceId', 'counts', 'parentTransferSha256', 'omittedOriginalFiles', 'retainedBytes']) assert.deepEqual(artifact[name], checked[name]);
  const manifest = JSON.parse(await readFile(join(output, 'release.json')));
  assert.equal(manifest.formatVersion, artifact.formatVersion);
  if (artifact.formatVersion === 2) for (const name of ['releaseFormatVersion', 'originalScope', 'sourceImagesRetained', 'retainedOriginalFiles', 'retainedOriginalBytes']) assert.deepEqual(artifact[name], checked[name]);
  assert.deepEqual(artifact.provenance, manifest.provenance);
  return { ...checked, status: 'release-assets-verified', artifactSha256 };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({ options: Object.fromEntries(['input', 'output', 'sha256'].map(k => [k, { type: 'string' }])) });
  console.log(JSON.stringify(await verifyReleaseAssets({ input: v.input, output: v.output, artifactSha256: v.sha256 }), null, 2));
}
