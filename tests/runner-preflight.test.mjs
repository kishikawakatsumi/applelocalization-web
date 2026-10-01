import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { validateImageJob } from '../scripts/run-image-job.mjs';
import { requirePreflightCapacity, ownedImage, preflightMinimumBytes } from '../scripts/preflight-localization-runner.mjs';

test('real acquisition requires explicit permission before input or output is touched', () => {
  validateImageJob({ kind: 'image', spec: '/fixture.json' });
  validateImageJob({ kind: 'ipsw', spec: '/fixture.json', allowDownload: true });
  assert.throws(() => validateImageJob({ kind: 'ipsw', spec: '/fixture.json' }), /allow-download/);
  assert.throws(() => validateImageJob({ kind: 'image', spec: '/fixture.json', allowDownload: true }));
  assert.throws(() => validateImageJob({ kind: 'installer', spec: '/fixture.json' }));
  assert.throws(() => validateImageJob({ kind: 'image', spec: '' }));
  assert.throws(() => execFileSync(process.execPath, ['scripts/run-image-job.mjs', '--kind', 'ipsw', '--spec', '/not-read', '--output', '/not-created'], { stdio: 'pipe' }), /allow-download/);
});
test('capacity is a bounded synthetic test requirement, not a claim about IPSW space', () => {
  requirePreflightCapacity(preflightMinimumBytes);
  for (const n of [0, -1, Infinity, NaN, '2147483648', preflightMinimumBytes - 1]) assert.throws(() => requirePreflightCapacity(n));
});
test('cleanup requires the exact read-only image and owned device association', () => {
  const image = { 'image-path': '/fixture/synthetic.dmg', writeable: false, 'system-entities': [{ 'dev-entry': '/dev/disk7' }] };
  assert.equal(ownedImage([image], '/fixture/synthetic.dmg', '/dev/disk7'), image);
  for (const images of [[], [image, image], [{ ...image, writeable: true }]]) assert.throws(() => ownedImage(images, '/fixture/synthetic.dmg', '/dev/disk7'));
  assert.throws(() => ownedImage([image], '/other.dmg', '/dev/disk7'));
  assert.throws(() => ownedImage([image], '/fixture/synthetic.dmg', '/dev/disk8'));
});
test('hosted preflight bootstrap is branch-scoped, bounded, secret-free and report-only', async () => {
  const workflow = await readFile('.github/workflows/localization-preflight.yml', 'utf8');
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /push:\n    branches: \[codex\/localization-runner-preflight\]/);
  assert.doesNotMatch(workflow, /pull_request:|schedule:|secrets\.|self-hosted|allow-download|scripts\/acquire-ipsw|sudo/);
  assert.match(workflow, /timeout-minutes: 15/);
  assert.match(workflow, /persist-credentials: false/);
  assert.match(workflow, /cancel-in-progress: false/);
  assert.match(workflow, /path: \$\{\{ runner.temp \}\}\/localization-preflight\/report.json/);
  assert.match(workflow, /retention-days: 7/);
  assert.match(workflow, /package-manager-cache: false/);
});
