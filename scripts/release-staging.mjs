// Explicit bridge: verified release v2 -> local-staging SQL -> full offline roundtrip receipt.
import assert from 'node:assert/strict';
import { lstat, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fileHash, writeJson } from './collection-checkpoints.mjs';
import { verifyIntermediateRelease } from './intermediate-release.mjs';
import { exportOccurrenceSQL } from './occurrence-staging.mjs';
import { auditOccurrenceSQL } from './audit-occurrence-sql.mjs';

async function verifiedSource(input, manifestSha256) {
  const checked = await verifyIntermediateRelease({ input, manifestSha256 });
  assert.equal(checked.releaseFormatVersion, 2, 'SQL bridge requires release v2 with all quarantined originals');
  return checked;
}

export async function verifyReleaseSQL({ input, sql, manifestSha256, progress }) {
  const release = await verifiedSource(input, manifestSha256);
  const packageRoot = join(input, 'package');
  const result = await auditOccurrenceSQL({ input: packageRoot, sql, packageManifest: await fileHash(join(packageRoot, 'report.json')), progress });
  assert.equal(result.quarantinedFiles, release.retainedOriginalFiles);
  assert.equal(result.quarantinedBytes, release.retainedOriginalBytes);
  await verifiedSource(input, manifestSha256); // Detect changed inputs; do not seal a stale source.
  return { ...result, status: 'release-staging-sql-verified-not-imported', releaseManifestSha256: manifestSha256,
    parentTransferSha256: release.parentTransferSha256, sourceId: release.sourceId,
    releaseFormatVersion: 2, allCollectedLanguages: true, productionReady: false };
}

export async function prepareReleaseSQL({ input, output, manifestSha256, schema, minimumFreeBytes, progress }) {
  await verifiedSource(input, manifestSha256);
  const root = await realpath(input), destination = resolve(output);
  assert.ok(destination !== root && !destination.startsWith(root + '/'), 'Keep SQL outside release');
  await exportOccurrenceSQL({ input: join(root, 'package'), output: destination, schema, minimumFreeBytes, progress });
  const result = await verifyReleaseSQL({ input: root, sql: destination, manifestSha256, progress });
  // Written last, exclusive. report.json alone only indicates export, not roundtrip success.
  await writeJson(join(destination, 'verification.json'), result);
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({ options: Object.fromEntries(['mode', 'input', 'output', 'sql', 'sha256', 'schema'].map(k => [k, { type: 'string' }])) });
  assert.ok(['prepare', 'verify'].includes(v.mode)); assert.ok(v.input && v.output && v.sha256);
  const args = { ...v, manifestSha256: v.sha256, progress: counts => console.log(JSON.stringify({ progress: counts })) };
  let result;
  if (v.mode === 'prepare') { assert.ok(v.schema && !v.sql); result = await prepareReleaseSQL(args); }
  else {
    assert.ok(v.sql && !v.schema);
    await assert.rejects(lstat(v.output), { code: 'ENOENT' }, 'Verification output must be new');
    result = await verifyReleaseSQL(args); await writeJson(v.output, result);
  }
  console.log(JSON.stringify(result, null, 2));
}
