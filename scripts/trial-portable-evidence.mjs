// Comparison only: do not rewrite saved resources, diagnostics or translations.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { readJsonLines } from './localization-jsonl.mjs';

export function portableProblem(problem, root) {
  assert.ok(typeof root === 'string' && root.startsWith('/') && root !== '/' && !root.endsWith('/'));
  const prefix = `ENOENT: no such file or directory, lstat '${root}/`;
  if (problem.code !== 'ENOENT' || !problem.message?.startsWith(prefix) || !problem.message.endsWith("'")) return false;
  const path = '/' + problem.message.slice(prefix.length, -1);
  assert.ok(path === problem.imagePath || path === posix.dirname(problem.imagePath), 'Unexpected missing metadata path');
  problem.message = `ENOENT: no such file or directory, lstat '<IMAGE_ROOT>${path}'`;
  return true;
}

export const portablePolicies = ['enoent-metadata-mount-prefix-v1', 'enoent-metadata-and-recovered-decode-v2'];

// Only a successful, single ETIMEDOUT retry is execution history rather than resource content.
// The saved row is never changed: this operates on a freshly decoded comparison copy.
export function portableRecoveredDecode(row) {
  const r = row.original;
  if (row.status !== 'parsed' || r?.status !== 'parsed' || r.decodeAttempts !== 2 || r.retryReason !== 'ETIMEDOUT') return null;
  const diagnostic = { resourceId: row.resourceId, imagePath: r.imagePath, sha256: r.sha256, decodeAttempts: r.decodeAttempts, retryReason: r.retryReason };
  r.decodeAttempts = 1; delete r.retryReason;
  return diagnostic;
}

export async function portableEvidence(packageRoot, mountRoot, { policy = portablePolicies[0], onRecoveredRetry = () => {} } = {}) {
  assert.ok(portablePolicies.includes(policy), 'Unknown portable comparison policy');
  const result = { policy, hashes: {}, replacements: {} };
  for (const stream of ['resources', 'issues']) {
    const hash = createHash('sha256'); let changes = 0;
    for await (const row of readJsonLines(packageRoot, stream + '.jsonl.gz')) {
      const problems = stream === 'resources' ? row.original?.bundleEvidence?.problems ?? [] : row.stage === 'bundle-metadata' ? [row] : [];
      for (const problem of problems) if (portableProblem(problem, mountRoot)) changes++;
      if (stream === 'resources' && policy === portablePolicies[1]) {
        const diagnostic = portableRecoveredDecode(row);
        if (diagnostic) onRecoveredRetry(diagnostic);
      }
      hash.update(JSON.stringify(row) + '\n');
    }
    result.hashes[stream] = hash.digest('hex'); result.replacements[stream] = changes;
  }
  return result;
}

export function binaryEvidence(binaryHashes) {
  assert.ok(binaryHashes && typeof binaryHashes === 'object');
  const entries = Object.entries(binaryHashes).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
  return { files: entries.length, sha256: createHash('sha256').update(JSON.stringify(entries)).digest('hex') };
}
