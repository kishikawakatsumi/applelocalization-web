import test from 'node:test';
import assert from 'node:assert/strict';
import { repository, validateRun, validateArtifact, validateLineage, verifyAssetSet } from '../scripts/archive-data-release.mjs';

const run = { id: 1, run_attempt: 1, head_sha: 'a'.repeat(40), repository: { full_name: repository },
  head_repository: { full_name: repository }, path: '.github/workflows/localization-unified-candidate.yml',
  head_branch: 'main', event: 'workflow_dispatch', status: 'completed', conclusion: 'success' };
const artifact = { id: 2, name: 'intermediate-ios27-os-1-1', size_in_bytes: 100, expired: false,
  digest: 'sha256:' + 'b'.repeat(64), workflow_run: { id: 1 } };
test('only successful same-repository main workflow runs are archived', () => {
  assert.equal(validateRun(run, 'localization-unified-candidate', 1), run);
  for (const change of [{ conclusion: 'failure' }, { event: 'pull_request' }, { head_branch: 'test' },
    { head_repository: { full_name: 'other/repo' } }, { run_attempt: 0 }, { head_sha: 'main' }]) {
    assert.throws(() => validateRun({ ...run, ...change }, 'localization-unified-candidate', 1));
  }
});
test('artifacts must match immutable pins and fit Release asset limits', () => {
  const pin = { id: 2, name: artifact.name, bytes: 100, digest: artifact.digest };
  assert.equal(validateArtifact(artifact, run, pin).digest, artifact.digest);
  assert.equal(validateArtifact({ ...artifact, name: 'intermediate-macos26-systemos-x86_64-1-1' }, run).id, 2);
  for (const change of [{ expired: true }, { digest: null }, { id: 3 }, { size_in_bytes: 101 },
    { name: '../unsafe' }, { workflow_run: { id: 3 } }, { size_in_bytes: 2 * 1024 ** 3 }]) {
    assert.throws(() => validateArtifact({ ...artifact, ...change }, run, pin));
  }
});
test('complete catalog determines precisely which intermediate components to retain', () => {
  const plan = { pins: [{ target: 'ios27', runId: 1 }] };
  const catalog = { allPlannedTargets: true, missingTargets: [], datasets: [{ id: 'ios27', version: '27.0.1', build: '24A446', components: [{ key: 'ios27-os' }] }] };
  const candidates = new Map([[1, { source: { runId: 9 }, ready: [{ target: { id: 'ios27', version: '27.0.1', build: '24A446' },
    components: [{ key: 'ios27-os', artifact }] }] }]]);
  assert.equal(validateLineage(plan, catalog, candidates)[0].source.runId, 9);
  assert.throws(() => validateLineage(plan, { ...catalog, allPlannedTargets: false }, candidates));
  assert.throws(() => validateLineage({ pins: [] }, catalog, candidates));
  const wrong = structuredClone(candidates); wrong.get(1).ready[0].target.build = 'other';
  assert.throws(() => validateLineage(plan, catalog, wrong));
  const missing = structuredClone(candidates); missing.get(1).ready[0].components = [];
  assert.throws(() => validateLineage(plan, catalog, missing));
});
test('resume/publication refuses missing, conflicting, duplicate or additional assets', () => {
  const assets = [{ name: 'data.zip', size: 100, digest: artifact.digest }];
  verifyAssetSet(assets, assets);
  assert.throws(() => verifyAssetSet([], assets));
  assert.throws(() => verifyAssetSet([...assets, ...assets], assets));
  assert.throws(() => verifyAssetSet([{ ...assets[0], digest: 'changed' }], assets));
});
