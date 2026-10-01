import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileHash, writeJson } from './collection-checkpoints.mjs';
import { verifyIntermediateRelease } from './intermediate-release.mjs';

export async function writeIntermediateAssets({ input, output, manifestSha256, trial = null }) {
  const checked = await verifyIntermediateRelease({ input, manifestSha256 });
  const manifest = JSON.parse(await readFile(join(input, 'release.json')));
  await mkdir(output, { mode: 0o700 });
  const archive = join(output, 'localization-intermediate.tar');
  await promisify(execFile)('/usr/bin/tar', ['-cf', archive, '-C', input, 'release.json', 'package', 'evidence'], { timeout: 300000 });
  const bytes = (await lstat(archive)).size; assert.ok(bytes < 2 * 1024 ** 3, 'Split larger releases before uploading');
  await writeJson(join(output, 'artifact.json'), { formatVersion: manifest.formatVersion, kind: 'localization-intermediate-release-artifact',
    archive: { name: 'localization-intermediate.tar', bytes, sha256: await fileHash(archive) }, ...checked,
    provenance: manifest.provenance, ...(trial ? { trial } : {}), completeOS: false, imported: false, publishedToWeb: false });
  return { ...checked, artifactSha256: await fileHash(join(output, 'artifact.json')) };
}
