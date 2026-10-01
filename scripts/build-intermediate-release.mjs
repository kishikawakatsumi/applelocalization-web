// Fixed normal iOS OS component; public output is separated from ephemeral images/raw resources.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { runHostedImageTrial } from './run-hosted-image-trial.mjs';
import { exportTransfer } from './package-transfer.mjs';
import { exportIntermediateRelease } from './intermediate-release.mjs';
import { fileHash, writeJson } from './collection-checkpoints.mjs';

export async function buildIntermediateRelease({ output, allowDownload = false, allowPublicData = false }) {
  assert.equal(allowDownload, true); assert.equal(allowPublicData, true, 'Explicit public parsed-data approval required');
  assert.match(process.env.GITHUB_SHA ?? '', /^[a-f0-9]{40}$/);
  assert.equal(process.env.GITHUB_REPOSITORY, 'kishikawakatsumi/applelocalization-tools');
  output = resolve(output); await mkdir(output, { mode: 0o700 });
  const work = join(output, 'work'); await mkdir(work, { mode: 0o700 });
  const trial = await runHostedImageTrial({ output: join(work, 'trial'), profile: 'os', allowDownload });
  const source = await exportTransfer({ collection: join(work, 'trial/job/collection'), output: join(work, 'transfer') });
  const configUrl = new URL('./hosted-os-trial.json', import.meta.url), config = JSON.parse(await readFile(configUrl));
  const provenance = { collectorRepository: process.env.GITHUB_REPOSITORY, collectorCommit: process.env.GITHUB_SHA,
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    acquisition: config.input, expectedDownload: config.expectedDownload, expectedImage: config.expectedImage,
    tool: config.tool, configSha256: await fileHash(configUrl), baselineComparison: trial.baselineComparison,
    recoveredDecodeRetries: trial.recoveredDecodeRetries ?? [] };
  const intermediate = await exportIntermediateRelease({ input: join(work, 'transfer'), output: join(work, 'intermediate'), manifestSha256: source.manifestSha256, provenance });
  const assets = join(output, 'assets'); await mkdir(assets, { mode: 0o700 });
  const archive = join(assets, 'localization-intermediate.tar');
  // Explicit roots only, already strict-inventory checked. Streams are already gzip-compressed.
  await promisify(execFile)('/usr/bin/tar', ['-cf', archive, '-C', join(work, 'intermediate'), 'release.json', 'package', 'evidence'], { timeout: 300000 });
  const bytes = (await lstat(archive)).size; assert.ok(bytes < 2 * 1024 ** 3, 'Split larger releases before uploading');
  await writeJson(join(assets, 'artifact.json'), { formatVersion: 1, kind: 'localization-intermediate-release-artifact',
    archive: { name: 'localization-intermediate.tar', bytes, sha256: await fileHash(archive) }, ...intermediate, provenance,
    trial: { status: trial.status, detached: trial.detached, elapsedMs: trial.elapsedMs, minimumObservedFreeBytes: trial.minimumObservedFreeBytes },
    completeOS: false, imported: false, publishedToWeb: false });
  console.log(JSON.stringify({ status: 'intermediate-release-assets-ready', assets, ...intermediate }, null, 2));
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({ options: { output: { type: 'string' }, 'allow-download': { type: 'boolean' }, 'allow-public-data': { type: 'boolean' } } });
  assert.ok(v.output); await buildIntermediateRelease({ output: v.output, allowDownload: v['allow-download'], allowPublicData: v['allow-public-data'] });
}
