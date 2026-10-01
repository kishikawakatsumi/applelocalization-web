import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { compareBaseline, validateTrial, verifyTrialPayload, runHostedImageTrial } from '../scripts/run-hosted-image-trial.mjs';
import { sha256 } from '../scripts/collection-checkpoints.mjs';

const config = JSON.parse(await readFile(new URL('../scripts/hosted-systemos-trial.json', import.meta.url)));
test('SystemOS is explicitly selected and bounded independently of small AppOS', async () => {
  validateTrial(config, true, 'systemos');
  assert.throws(() => validateTrial(config, true));
  assert.throws(() => validateTrial(config, false, 'systemos'), /allow-download/);
  await assert.rejects(runHostedImageTrial({ output: '/not-created', profile: '../other', allowDownload: true }), /Unknown/);
  await assert.rejects(runHostedImageTrial({ output: '/not-created', profile: 'systemos' }), /allow-download/);
  for (const change of [
    c => c.input.component = 'OS', c => c.input.imagePath = 'image.dmg',
    c => c.input.maximumDownloadBytes = 4 * 1024 ** 3,
    c => c.input.maximumImageBytes = 7 * 1024 ** 3,
    c => delete c.expectedDownload, c => c.expectedDownload.sha256 = 'bad',
    c => c.expectedDownload.bytes = 4 * 1024 ** 3,
    c => c.expectedImage.bytes = 7 * 1024 ** 3,
  ]) { const value = structuredClone(config); change(value); assert.throws(() => validateTrial(value, true, 'systemos')); }
});
test('both encrypted and decrypted payloads require actual bytes and reject symlinks', async () => {
  const root = await mkdtemp(join(tmpdir(), 'trial-payload-'));
  const path = join(root, 'payload'); await writeFile(path, 'fixture');
  const expected = { bytes: 7, sha256: sha256('fixture') };
  assert.deepEqual(await verifyTrialPayload(path, expected), expected);
  await assert.rejects(verifyTrialPayload(path, { ...expected, bytes: 8 }), /size/);
  await writeFile(path, 'changed');
  await assert.rejects(verifyTrialPayload(path, expected), /hash/);
  const link = join(root, 'link'); await symlink(path, link);
  await assert.rejects(verifyTrialPayload(link, expected));
});
test('SystemOS baseline retains structured values and symlink evidence', () => {
  const report = { ...structuredClone(config.baseline), status: 'prepared-not-imported' };
  assert.equal(compareBaseline(report, config.baseline).status, 'baseline-logical-content-verified');
  report.counts.structuredRows--;
  assert.throws(() => compareBaseline(report, config.baseline));
});
test('SystemOS is manual opt-in and report-only', async () => {
  const workflow = await readFile('.github/workflows/localization-systemos-trial.yml', 'utf8');
  assert.match(workflow, /if: inputs.allow_download == true/);
  for (const value of ['workflow_dispatch:', 'default: false', 'inputs.allow_download == true', 'runs-on: macos-15', 'timeout-minutes: 30', 'contents: read', 'persist-credentials: false', 'package-manager-cache: false', 'cancel-in-progress: false', '--profile systemos --allow-download', 'retention-days: 7']) assert.ok(workflow.includes(value), value);
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/localization-systemos-trial\/report.json/);
  assert.doesNotMatch(workflow, /secrets\.|sudo|push:|pull_request:|schedule:|self-hosted|deploy|docker/);
});
