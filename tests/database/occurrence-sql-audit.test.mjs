import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { ownershipPackageFixture } from '../helpers/ownership-package-fixture.mjs';
import { exportOccurrenceSQL } from '../../scripts/database/occurrence-sql.mjs';
import { auditOccurrenceSQL } from '../../scripts/database/audit-occurrence-sql.mjs';
import { fileHash } from '../../scripts/shared/collection-checkpoints.mjs';
import { structuredSearchIndexSQL } from '../../scripts/database/structured-search.mjs';

test('SQL auditor accepts pinned historical layout but does not accept missing JSON index in new layout', async () => {
  const f = await ownershipPackageFixture(), input=f.v2, sql=join(f.temp,'old-index-sql');
  const schema='ipsw_trial_old_index';
  await exportOccurrenceSQL({input,output:sql,schema,minimumFreeBytes:0});
  const report=JSON.parse(await readFile(join(sql,'report.json')));
  assert.equal(report.searchIndexVersion,2);
  const original=gunzipSync(await readFile(join(sql,'import.sql.gz'))).toString();
  await writeFile(join(sql,'import.sql.gz'),gzipSync(original.replace(structuredSearchIndexSQL(schema)+'\n','')));
  report.sqlSha256=await fileHash(join(sql,'import.sql.gz'));
  await writeFile(join(sql,'report.json'),JSON.stringify(report));
  const args={input,sql,packageManifest:await fileHash(join(input,'report.json'))};
  await assert.rejects(auditOccurrenceSQL(args),/Unexpected SQL statement/);
  delete report.searchIndexVersion;
  await writeFile(join(sql,'report.json'),JSON.stringify(report));
  assert.equal((await auditOccurrenceSQL(args)).status,'sql-file-full-roundtrip-verified');
});

test('offline SQL audit restores v1/v2 values, corrected owners, language profiles and originals', async () => {
  const f = await ownershipPackageFixture();
  for (const version of ['v1', 'v2']) {
    const input = f[version], sql = join(f.temp, 'sql-' + version);
    await exportOccurrenceSQL({ input, output: sql, schema: 'ipsw_trial_roundtrip_' + version, minimumFreeBytes: 0 });
    const result = await auditOccurrenceSQL({ input, sql, packageManifest: await fileHash(join(input, 'report.json')) });
    assert.equal(result.status, 'sql-file-full-roundtrip-verified');
    assert.equal(result.stats.rows, 18); assert.equal(result.stats.keyFallbackRows, 1);
    assert.equal(result.stats.targetFallbackRows, 2); assert.equal(result.stats.structuredRows, 1);
    assert.equal(result.resources, 7); assert.equal(result.languageProfiles, 6);
    assert.ok(result.quarantinedFiles > 0); assert.equal(result.imported, false);
  }
});

test('offline SQL audit rejects altered SQL even when its own report checksum is recomputed', async () => {
  const f = await ownershipPackageFixture(), input = f.v2, sql = join(f.temp, 'sql');
  await exportOccurrenceSQL({ input, output: sql, schema: 'ipsw_trial_adversarial', minimumFreeBytes: 0 });
  const original = gunzipSync(await readFile(join(sql, 'import.sql.gz'))).toString();
  const report = JSON.parse(await readFile(join(sql, 'report.json')));
  const manifest = await fileHash(join(input, 'report.json'));
  const replaceRows = (text, table, change) => text.replace(new RegExp(`(COPY ipsw_trial_adversarial\\.${table} FROM stdin;\\n)([\\s\\S]*?)(\\\\\\.\\n)`), (_, start, body, end) => start + change(body) + end);
  const mutations = [
    text => text + 'DROP SCHEMA public CASCADE;\n',
    text => text.replace('BEGIN;', 'BEGIN; DROP TABLE public.ios26;'),
    text => text.replace('COMMIT;', 'ROLLBACK;'),
    text => text.slice(0, -50),
    text => replaceRows(text, 'occurrence', body => body.split('\n').slice(1).join('\n')),
    text => replaceRows(text, 'occurrence', body => body.replace(/^1\t[^\t]+\t/, '1\t999999\t')),
    text => replaceRows(text, 'occurrence', body => body.replace('開く', '営業中')),
    text => replaceRows(text, 'resource', body => body.replace(/^(1\t[^\t]+\t[^\t]+\t)[^\t]+/, '$1999999')),
    text => replaceRows(text, 'quarantine', () => ''),
    text => replaceRows(text, 'language', body => body + body.split('\n')[0] + '\n'),
  ];
  for (let i = 0; i < mutations.length; i++) {
    const changed = mutations[i](original); assert.notEqual(changed, original, `Mutation ${i} must change SQL`);
    const bad = join(f.temp, 'bad-' + i); await mkdir(bad);
    await writeFile(join(bad, 'import.sql.gz'), gzipSync(changed));
    await writeFile(join(bad, 'report.json'), JSON.stringify({ ...report, sqlSha256: await fileHash(join(bad, 'import.sql.gz')) }));
    await assert.rejects(auditOccurrenceSQL({ input, sql: bad, packageManifest: manifest }), `Mutation ${i} must fail`);
  }
  await assert.rejects(auditOccurrenceSQL({ input, sql, packageManifest: '0'.repeat(64) }), /Package manifest differs/);
  await writeFile(join(sql, 'import.sql.gz'), gzipSync(original + '\n'));
  await assert.rejects(auditOccurrenceSQL({ input, sql, packageManifest: manifest }), /SQL checksum mismatch/);
});
