import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { compareBaseline, trialConfigUrl, validateTrial } from '../scripts/run-hosted-appos-trial.mjs';

const config = JSON.parse(await readFile(trialConfigUrl));
test('real hosted trial requires explicit permission before creating any output', () => {
  assert.throws(() => validateTrial(config, false), /allow-download/);
  assert.throws(() => execFileSync(process.execPath, ['scripts/run-hosted-appos-trial.mjs', '--output', '/not-created'], { stdio: 'pipe' }), /allow-download/);
  validateTrial(config, true);
});
test('trial pins a bounded, plain AppOS component and a specific tool distribution', () => {
  for (const change of [
    c => c.input.component = 'OS', c => c.input.imagePath += '.aea',
    c => c.input.maximumDownloadBytes = 129 * 1024 ** 2,
    c => c.input.maximumImageBytes = 0, c => c.tool.url += '?other',
    c => c.tool.binarySha256 = 'bad', c => c.input.manifestSha256 = 'bad',
    c => c.tool.archiveBytes = Infinity, c => c.expectedImage.bytes = -1,
  ]) { const value = structuredClone(config); change(value); assert.throws(() => validateTrial(value, true)); }
});
test('baseline requires every occurrence, context, catalog and exact logical content', () => {
  const report = { ...structuredClone(config.baseline), status: 'prepared-not-imported' };
  report.contentHashes.sources = 'deliberately host specific';
  assert.equal(compareBaseline(report, config.baseline).status, 'baseline-logical-content-verified');
  for (const change of [
    r => r.sourceId += 'changed', r => r.counts.occurrences--,
    r => r.contentHashes.occurrences = 'changed', r => r.contentHashes.resources = 'changed',
    r => r.contentHashes.tables = 'changed', r => r.contentHashes.issues = 'changed',
    r => r.contentHashes.symlinks = 'changed', r => r.catalogSha256 = 'changed',
  ]) { const value = structuredClone(report); change(value); assert.throws(() => compareBaseline(value, config.baseline)); }
});
test('hosted trial is opt-in manual-only and retains only a small report', async () => {
  const workflow = await readFile('.github/workflows/localization-appos-trial.yml', 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /default: false/);
  assert.match(workflow, /if: inputs.allow_download == true/);
  assert.match(workflow, /runs-on: macos-15/);
  assert.match(workflow, /timeout-minutes: 30/);
  assert.match(workflow, /contents: read/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /package-manager-cache: false/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/localization-appos-trial\/report.json/);
  assert.match(workflow, /retention-days: 7/);
  assert.doesNotMatch(workflow, /secrets\.|sudo|push:|pull_request:|schedule:|self-hosted|deploy|docker/);
});
