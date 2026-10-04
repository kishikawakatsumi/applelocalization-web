// Explicit tiny-fixture writes to the existing LOCAL staging DB only; preserves its new schema.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import { ownershipPackageFixture } from './helpers/ownership-package-fixture.mjs';
import { exportOccurrenceSQL, psqlProcess, psqlLines } from '../scripts/occurrence-staging.mjs';
import { localDockerOnly } from '../scripts/load-occurrence-staging.mjs';
import { auditOccurrenceStaging } from '../scripts/audit-occurrence-staging.mjs';
import { auditOccurrenceSQL } from '../scripts/audit-occurrence-sql.mjs';
import { fileHash } from '../scripts/collection-checkpoints.mjs';

test('durable fixture commits logged tables and roundtrips every original value and corrected context', { skip: process.env.LOCAL_IPSW_DB_TEST !== '1' }, async () => {
  localDockerOnly();
  const f = await ownershipPackageFixture(), output = join(f.temp, 'durable');
  const schema = `localization_fixture_${process.pid}`;
  const exported = await exportOccurrenceSQL({ input: f.v2, output, schema, database: 'localization_staging', durable: true });
  await auditOccurrenceSQL({ input: f.v2, sql: output, packageManifest: await fileHash(join(f.v2, 'report.json')), database: 'localization_staging', durable: true });
  const child = psqlProcess(); let stderr = '';
  child.stderr.on('data', bytes => { stderr += bytes; }); child.stdout.resume();
  const done = new Promise((resolve, reject) => { child.on('error', reject); child.on('close', code => code === 0 ? resolve() : reject(new Error(stderr))); });
  done.catch(() => {});
  try { await pipeline(createReadStream(join(output, 'import.sql.gz')), createGunzip(), child.stdin); await done; }
  finally { if (child.exitCode === null) child.kill(); await done.catch(() => {}); }
  const persistence = [];
  for await (const row of psqlLines(`BEGIN READ ONLY; SELECT count(*),bool_and(c.relpersistence='p') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}' AND c.relkind='r'; COMMIT;`)) persistence.push(row);
  assert.deepEqual(persistence, ['10|t']);
  const audit = await auditOccurrenceStaging({ input: f.v2, schema, durable: true });
  assert.equal(audit.rows, 18); assert.equal(audit.status, 'database-full-roundtrip-verified');
  console.log(JSON.stringify({ schema, output, sqlSha256: exported.sqlSha256, audit, loggedTables: 10 }));
});
