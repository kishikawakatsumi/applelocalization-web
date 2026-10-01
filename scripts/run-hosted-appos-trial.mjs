// Keep the existing AppOS entry point fixed to the small, plain-DMG profile.
import assert from 'node:assert/strict';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { runHostedImageTrial } from './run-hosted-image-trial.mjs';
export { trialConfigUrl, validateTrial, compareBaseline } from './run-hosted-image-trial.mjs';
export const runHostedApposTrial = options => runHostedImageTrial({ ...options, profile: 'appos' });

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { output: { type: 'string' }, 'allow-download': { type: 'boolean', default: false } } });
  assert.ok(values.output, '--output required');
  const report = await runHostedApposTrial({ output: values.output, allowDownload: values['allow-download'] });
  console.log(JSON.stringify({ status: report.status, counts: report.package.counts, elapsedMs: report.elapsedMs, minimumObservedFreeBytes: report.minimumObservedFreeBytes }));
}
