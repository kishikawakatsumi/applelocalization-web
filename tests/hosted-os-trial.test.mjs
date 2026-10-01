import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { portableEvidence, portableProblem, binaryEvidence } from '../scripts/trial-portable-evidence.mjs';
import { validateTrial, compareBaseline } from '../scripts/run-hosted-image-trial.mjs';

const config = JSON.parse(await readFile(new URL('../scripts/hosted-os-trial.json', import.meta.url)));
test('OS trial has independent bounded budgets and requires portable and quarantine evidence', () => {
  validateTrial(config, true, 'os');
  assert.throws(() => validateTrial(config, false, 'os'));
  assert.throws(() => validateTrial(config, true, 'systemos'));
  for (const change of [c => c.input.maximumDownloadBytes = 10 * 1024 ** 3, c => c.input.maximumImageBytes = 11 * 1024 ** 3,
    c => delete c.baseline.portableEvidence, c => c.baseline.binaryEvidence.files--]) {
    const value = structuredClone(config); change(value); assert.throws(() => validateTrial(value, true, 'os'));
  }
});
test('portable diagnostics normalize only the exact known mount prefix in missing metadata errors', () => {
  const problem = { imagePath: '/A.framework/Resources/Info.plist', code: 'ENOENT', message: "ENOENT: no such file or directory, lstat '/mount/A.framework/Resources'" };
  const copy = structuredClone(problem); assert.equal(portableProblem(copy, '/mount'), true);
  assert.equal(copy.message, "ENOENT: no such file or directory, lstat '<IMAGE_ROOT>/A.framework/Resources'");
  for (const changed of [{ ...problem, code: 'EACCES' }, { ...problem, message: problem.message.replace('/mount/', '/other/') }]) {
    const before = structuredClone(changed); assert.equal(portableProblem(changed, '/mount'), false); assert.deepEqual(changed, before);
  }
  assert.throws(() => portableProblem({ ...problem, imagePath: '/Unrelated/Info.plist' }, '/mount'));
});
test('portable hashes preserve every other diagnostic and resource field without editing inputs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'portable-trial-'));
  const rows = { resources: [{ original: { target: 'literal /mount/string', bundleEvidence: { problems: [] } } }], issues: [] };
  for (const [name, data] of Object.entries(rows)) await writeFile(join(dir, name+'.jsonl.gz'), gzipSync(data.map(r=>JSON.stringify(r)+'\n').join('')));
  const before = await readFile(join(dir, 'resources.jsonl.gz'));
  const evidence = await portableEvidence(dir, '/mount');
  assert.equal(evidence.replacements.resources, 0);
  assert.deepEqual(await readFile(join(dir, 'resources.jsonl.gz')), before);
  rows.resources[0].original.target = 'changed';
  await writeFile(join(dir, 'resources.jsonl.gz'), gzipSync(JSON.stringify(rows.resources[0])+'\n'));
  assert.notEqual((await portableEvidence(dir, '/mount')).hashes.resources, evidence.hashes.resources);
});
test('quarantine contents and portable evidence cannot be omitted from comparison', () => {
  const baseline = { ...structuredClone(config.baseline), binaryEvidence: binaryEvidence({ a: 'first' }) };
  const report = { ...structuredClone(baseline), status: 'prepared-not-imported', binaryHashes: { a: 'first' } };
  assert.equal(compareBaseline(report, baseline, baseline.portableEvidence).status, 'baseline-logical-content-verified');
  assert.throws(() => compareBaseline(report, baseline));
  report.binaryHashes.a = 'changed';
  assert.throws(() => compareBaseline(report, baseline, baseline.portableEvidence), /Quarantined/);
});
test('OS trial bootstrap is scoped and report-only', async () => {
  const workflow = await readFile('.github/workflows/localization-os-trial.yml', 'utf8');
  assert.match(workflow, /push:\n    branches: \[codex\/localization-os-trial\]/);
  for (const value of ['workflow_dispatch:', 'default: false', 'inputs.allow_download == true', 'runs-on: macos-15', 'timeout-minutes: 45', 'contents: read', 'persist-credentials: false', 'package-manager-cache: false', 'cancel-in-progress: false', '--profile os --allow-download', 'retention-days: 7']) assert.ok(workflow.includes(value));
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/localization-os-trial\/report.json/);
  assert.doesNotMatch(workflow, /secrets\.|sudo|pull_request:|schedule:|self-hosted|deploy|docker/);
});
