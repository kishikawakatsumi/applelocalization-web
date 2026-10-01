// Restore only bytes explicitly pinned by the old release. Never rewrite its receipts or outputs.
import assert from 'node:assert/strict';
import { constants } from 'node:fs';
import { copyFile, mkdir, realpath, lstat, writeFile } from 'node:fs/promises';
import { dirname, basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { safeRead } from './inspect-unlocalized-resources.mjs';
import { checkSpace, fileHash, sha256 } from './collection-checkpoints.mjs';
import { verifyTransfer } from './package-transfer.mjs';
import { verifyIntermediateRelease, exportIntermediateRelease } from './intermediate-release.mjs';
import { writeIntermediateAssets } from './intermediate-assets.mjs';

export async function restoreQuarantinedRelease({ input, manifestSha256, quarantine, output, minimumFreeBytes = 10 * 1024 ** 3 }) {
  const old = await verifyIntermediateRelease({ input, manifestSha256 });
  assert.equal(old.originalsRetained, false, 'Only omitted-original releases need recovery');
  assert.ok((await lstat(quarantine)).isDirectory(), 'Quarantine root cannot be a symlink');
  input = await realpath(input); quarantine = await realpath(quarantine); output = resolve(output);
  for (const root of [input, quarantine]) assert.ok(output !== root && !output.startsWith(root + '/'));
  const manifest = JSON.parse(await safeRead(input, 'release.json'));
  const parentBytes = await safeRead(input, 'evidence/transfer-manifest.json'), parent = JSON.parse(parentBytes);
  await checkSpace(dirname(output), minimumFreeBytes + parent.payloadBytes * 3 + 16 * 1024 ** 2);
  await mkdir(output, { mode: 0o700 });
  const transfer = join(output, 'restored-transfer'); await mkdir(transfer, { mode: 0o700 });
  for (const [name, pin] of Object.entries(parent.files)) {
    if (name === '/') continue;
    const destination = join(transfer, name);
    if (pin === null) { await mkdir(destination, { recursive: true, mode: 0o700 }); continue; }
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    if (Object.hasOwn(manifest.omittedOriginals, name)) {
      const bytes = await safeRead(quarantine, basename(name));
      assert.equal(bytes.length, pin.bytes, 'Recovered original size differs');
      assert.equal(sha256(bytes), pin.sha256, 'Recovered original hash differs');
      await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
    } else await copyFile(join(input, name), destination, constants.COPYFILE_EXCL);
  }
  await writeFile(join(transfer, 'manifest.json'), parentBytes, { flag: 'wx', mode: 0o600 });
  await verifyTransfer({ input: transfer, manifestSha256: old.parentTransferSha256 });
  const code = {};
  for (const name of ['restore-quarantined-release.mjs', 'intermediate-release.mjs', 'intermediate-assets.mjs']) code[name] = await fileHash(new URL(name, import.meta.url));
  const provenance = { ...manifest.provenance, retentionMigration: { fromReleaseManifestSha256: manifestSha256,
    method: 'restore-every-omitted-original-by-pinned-size-and-sha256', codeSha256: code,
    note: 'Retention migration only; parsed streams and original extraction audit receipts are unchanged.' } };
  const intermediate = join(output, 'intermediate');
  const upgraded = await exportIntermediateRelease({ input: transfer, output: intermediate, manifestSha256: old.parentTransferSha256, provenance, minimumFreeBytes });
  return writeIntermediateAssets({ input: intermediate, output: join(output, 'assets'), manifestSha256: upgraded.manifestSha256 });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({ options: Object.fromEntries(['input', 'sha256', 'quarantine', 'output'].map(k => [k, { type: 'string' }])) });
  console.log(JSON.stringify(await restoreQuarantinedRelease({ input: v.input, manifestSha256: v.sha256, quarantine: v.quarantine, output: v.output }), null, 2));
}
