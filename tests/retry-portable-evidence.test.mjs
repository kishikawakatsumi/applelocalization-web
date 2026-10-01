import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { gzipSync } from 'node:zlib';
import { portableEvidence, portableRecoveredDecode, portablePolicies } from '../scripts/trial-portable-evidence.mjs';
import { compareBaseline } from '../scripts/run-hosted-image-trial.mjs';

const ordinary = { resourceId: 'a'.repeat(64), status: 'parsed', rows: 1,
  original: { imagePath: '/A/ja.lproj/Localizable.strings', sha256: 'b'.repeat(64), decodeAttempts: 1, status: 'parsed', rows: 1 } };
const retry = () => ({ ...structuredClone(ordinary), original: { ...ordinary.original, decodeAttempts: 2, retryReason: 'ETIMEDOUT' } });
test('comparison excludes only successful single timeout retries, preserving all other content and diagnostics', () => {
  const row = retry(), d = portableRecoveredDecode(row);
  assert.equal(d.retryReason, 'ETIMEDOUT'); assert.equal(d.decodeAttempts, 2); assert.deepEqual(row, ordinary);
  for (const change of [r => r.status = 'failed', r => r.original.status = 'failed', r => r.original.decodeAttempts = 3,
    r => r.original.retryReason = 'EACCES', r => r.original.decodeAttempts = 1]) {
    const r = retry(); change(r); const before = structuredClone(r);
    assert.equal(portableRecoveredDecode(r), null); assert.deepEqual(r, before);
  }
});
test('v2 comparison retains raw retry evidence, preserves legacy v1 and rejects unrelated resource changes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'retry-evidence-'));
  await writeFile(join(root, 'issues.jsonl.gz'), gzipSync(''));
  const file = join(root, 'resources.jsonl.gz'), put = r => writeFile(file, gzipSync(JSON.stringify(r) + '\n'));
  const v2 = { policy: portablePolicies[1] }, diagnostics = [];
  await put(ordinary); const baseline = await portableEvidence(root, '/mount', v2);
  await put(retry()); const before = await readFile(file);
  const actual = await portableEvidence(root, '/mount', { ...v2, onRecoveredRetry: d => diagnostics.push(d) });
  assert.deepEqual(actual, baseline); assert.equal(diagnostics.length, 1);
  assert.deepEqual(await readFile(file), before);
  assert.notEqual((await portableEvidence(root, '/mount')).hashes.resources, baseline.hashes.resources);
  for (const key of ['sha256', 'imagePath', 'rows']) {
    const changed = retry(); changed.original[key] = 'changed'; await put(changed);
    assert.notEqual((await portableEvidence(root, '/mount', v2)).hashes.resources, baseline.hashes.resources);
  }
  const config = JSON.parse(await readFile(new URL('../scripts/hosted-os-trial.json', import.meta.url)));
  const report = { ...structuredClone(config.baseline), status: 'prepared-not-imported' };
  report.contentHashes.occurrences = 'c'.repeat(64);
  assert.throws(() => compareBaseline(report, config.baseline, config.baseline.portableEvidence), /occurrences logical content differs/);
});
