// Generate a durable-storage candidate only. Never connects to a database or publishes data.
import assert from 'node:assert/strict';
import { realpath } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { fileHash, writeJson } from '../shared/collection-checkpoints.mjs';
import { verifyIntermediateRelease } from '../package/intermediate-release.mjs';
import { exportOccurrenceSQL, occurrenceSQLLayout } from './occurrence-sql.mjs';
import { auditOccurrenceSQL } from './audit-occurrence-sql.mjs';

export async function prepareDurableReleaseSQL({ input, output, manifestSha256, schema, database, minimumFreeBytes, progress }) {
  occurrenceSQLLayout({ schema, database, durable: true });
  const source = await verifyIntermediateRelease({ input, manifestSha256 });
  assert.equal(source.releaseFormatVersion, 2, 'Durable export requires retained quarantine originals');
  input = await realpath(input);
  output = join(await realpath(dirname(resolve(output))), basename(output));
  assert.ok(output !== input && !output.startsWith(input + '/'), 'Keep SQL outside release');
  const packageRoot = join(input, 'package');
  await exportOccurrenceSQL({ input: packageRoot, output, schema, database, durable: true, minimumFreeBytes, progress });
  const verified = await auditOccurrenceSQL({ input: packageRoot, sql: output,
    packageManifest: await fileHash(join(packageRoot, 'report.json')), durable: true, database, progress });
  assert.equal(verified.quarantinedFiles, source.retainedOriginalFiles);
  assert.equal(verified.quarantinedBytes, source.retainedOriginalBytes);
  await verifyIntermediateRelease({ input, manifestSha256 });
  const result = { ...verified, status: 'durable-release-sql-verified-not-imported', sourceId: source.sourceId,
    releaseManifestSha256: manifestSha256, parentTransferSha256: source.parentTransferSha256,
    allCollectedLanguages: true, apiCompatible: false, productionReady: false };
  await writeJson(join(output, 'verification.json'), result);
  return result;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({ options: Object.fromEntries(['input', 'output', 'sha256', 'schema', 'database'].map(k => [k, { type: 'string' }])) });
  assert.ok(v.input && v.output && v.sha256 && v.schema && v.database);
  console.log(JSON.stringify(await prepareDurableReleaseSQL({ ...v, manifestSha256: v.sha256,
    progress: counts => console.log(JSON.stringify({ progress: counts })) }), null, 2));
}
