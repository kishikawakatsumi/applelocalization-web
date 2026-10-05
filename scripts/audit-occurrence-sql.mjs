// Offline COPY roundtrip audit. Never executes SQL or connects to a database.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { readSQLLines, sqlLineLimit } from './sql-lines.mjs';
import { safeRead } from './inspect-unlocalized-resources.mjs';
import { fileHash, sha256 } from './collection-checkpoints.mjs';
import { effectiveResource, validateOccurrencePackage, verifyOwnershipCount } from './occurrence-package.mjs';
import { tableContext } from './prepare-localization-package.mjs';
import { copyField, parseCopyLine, occurrenceSQLLayout, stagingDatabase, stagingContainer } from './occurrence-staging.mjs';

export async function auditOccurrenceSQL({ input, sql, packageManifest, durable = false, database, progress = () => {} }) {
  assert.match(packageManifest, /^[a-f0-9]{64}$/);
  const root = await realpath(input), directory = await realpath(sql);
  const reportBytes = await safeRead(root, 'report.json');
  assert.equal(sha256(reportBytes), packageManifest, 'Package manifest differs');
  const report = JSON.parse(reportBytes); validateOccurrencePackage(report);
  const catalogBytes = await safeRead(root, 'catalog.json');
  assert.equal(sha256(catalogBytes), report.catalogSha256);
  const catalog = JSON.parse(catalogBytes);
  const sqlReportBytes = await safeRead(directory, 'report.json'), exported = JSON.parse(sqlReportBytes);
  assert.equal(exported.status, durable ? 'durable-occurrence-sql-prepared' : 'staging-sql-prepared');
  if (durable) { assert.equal(exported.storage, 'logged'); assert.equal(exported.database, database); }
  else { assert.equal(exported.database, stagingDatabase); assert.equal(exported.container, stagingContainer); }
  assert.equal(exported.packageManifest, packageManifest);
  const schema = exported.schema, layout = occurrenceSQLLayout({ schema, durable, database, searchIndexVersion: exported.searchIndexVersion ?? 1 }), path = join(directory, 'import.sql.gz');
  assert.equal(await fileHash(path), exported.sqlSha256, 'SQL checksum mismatch');
  const lines = readSQLLines(path, sqlLineLimit(exported))[Symbol.asyncIterator]();
  const next = async () => { const line = await lines.next(); assert.ok(!line.done, 'Truncated SQL'); return line.value; };
  const expect = async text => { for (const line of text.split('\n')) assert.equal(await next(), line, 'Unexpected SQL statement'); };
  async function* rows(table, width) {
    await expect(`COPY ${schema}.${table} FROM stdin;`);
    while (true) {
      const line = await next(); if (line === '\\.') return;
      const fields = parseCopyLine(line);
      assert.equal(fields.length, width, `COPY width: ${table}`);
      assert.equal(fields.map(copyField).join('\t'), line, 'Noncanonical COPY encoding');
      yield fields;
    }
  }
  const bundles = new Map(), resources = new Map(), tables = new Map(), languages = new Map();
  const contentHashes = {}, stats = { rows: 0, textRows: 0, structuredRows: 0, keyFallbackRows: 0, targetFallbackRows: 0 };
  let corrected = 0, quarantineBytes = 0;
  const quarantine = new Set();
  try {
    await expect(layout.header);
    let packageCount = 0;
    for await (const fields of rows('package', 4)) {
      packageCount++;
      assert.deepEqual(fields, ['1', packageManifest, reportBytes.toString(), catalogBytes.toString()]);
    }
    assert.equal(packageCount, 1);
    const tableIds = new Set();
    for (const [stream, table] of [['sources', 'source'], ['tables', 'resource_table'], ['issues', 'issue'], ['symlinks', 'symlink']]) {
      const hash = createHash('sha256'); let count = 0;
      for await (const fields of rows(table, stream === 'tables' ? 3 : 2)) {
        assert.equal(fields[0], String(++count));
        const record = JSON.parse(fields.at(-1)); hash.update(JSON.stringify(record) + '\n');
        if (stream === 'tables') {
          assert.equal(fields[1], record.tableId);
          assert.ok(!tableIds.has(record.tableId), 'Duplicate table ID'); tableIds.add(record.tableId);
          tables.set(fields[0], record);
        }
      }
      contentHashes[stream] = hash.digest('hex');
      assert.equal(contentHashes[stream], report.contentHashes[stream], `Metadata differs: ${stream}`);
    }
    const bundlePaths = new Set();
    for await (const [id, path] of rows('bundle', 2)) {
      assert.equal(id, String(bundles.size + 1)); assert.ok(!bundlePaths.has(path));
      bundles.set(id, path); bundlePaths.add(path);
    }
    const resourceHash = createHash('sha256'), resourceIds = new Set(), usedBundles = new Set();
    for await (const [id, resourceId, tableId, bundleId, status, expected, metadata] of rows('resource', 7)) {
      const record = JSON.parse(metadata), owner = effectiveResource(record, report);
      assert.equal(id, String(resources.size + 1)); assert.equal(resourceId, record.resourceId);
      assert.ok(!resourceIds.has(resourceId)); resourceIds.add(resourceId);
      assert.ok(bundles.has(bundleId)); assert.equal(bundles.get(bundleId), owner.bundlePath); usedBundles.add(bundleId);
      assert.equal(status, record.status); assert.equal(expected, String(record.rows));
      assert.equal(tableId === null ? null : tables.get(tableId)?.tableId, record.tableId);
      if (tableId !== null) assert.deepEqual(tables.get(tableId), tableContext(owner, record.supplement));
      else { assert.equal(status, 'unresolved'); assert.equal(expected, '0'); }
      if (record.ownershipCorrection) corrected++;
      resourceHash.update(JSON.stringify(record) + '\n'); resources.set(id, { record, seen: 0 });
    }
    assert.equal(usedBundles.size, bundles.size); verifyOwnershipCount(report, corrected);
    contentHashes.resources = resourceHash.digest('hex'); assert.equal(contentHashes.resources, report.contentHashes.resources);
    for await (const [id, code, raw, basis, status, expected] of rows('language', 6)) {
      assert.equal(id, String(languages.size + 1));
      const value = { language: code, raw, basis, status, rows: Number(expected) };
      assert.deepEqual(value, catalog.languages[languages.size]); languages.set(id, { ...value, seen: 0 });
    }
    assert.equal(languages.size, catalog.languages.length);
    for await (const [path, hex] of rows('quarantine', 2)) {
      assert.ok(!quarantine.has(path)); assert.ok(Object.hasOwn(report.binaryHashes, path));
      assert.match(hex, /^\\x(?:[a-f0-9]{2})*$/);
      const bytes = Buffer.from(hex.slice(2), 'hex');
      assert.equal(sha256(bytes), report.binaryHashes[path]); quarantine.add(path); quarantineBytes += bytes.length;
    }
    assert.equal(quarantine.size, Object.keys(report.binaryHashes).length);
    const occurrenceHash = createHash('sha256'); let lastProgress = Date.now();
    for await (const [id, resourceId, ordinal, languageId, keyText, keyJSON, kind, targetText, targetJSON] of rows('occurrence', 9)) {
      const resource = resources.get(resourceId), language = languages.get(languageId);
      assert.ok(resource && language, 'Unknown resource or language');
      assert.equal(id, String(++stats.rows)); assert.equal(ordinal, String(++resource.seen)); language.seen++;
      assert.ok((keyText === null) !== (keyJSON === null));
      assert.ok(['text', 'structured'].includes(kind));
      assert.ok((targetText === null) !== (targetJSON === null));
      const key = keyText === null ? JSON.parse(keyJSON) : keyText;
      const target = targetText === null ? JSON.parse(targetJSON) : targetText;
      assert.equal(typeof key, 'string');
      if (kind === 'text') assert.equal(typeof target, 'string');
      else { assert.equal(targetText, null); assert.ok(target && typeof target === 'object' && !Array.isArray(target)); }
      stats[kind === 'text' ? 'textRows' : 'structuredRows']++;
      if (keyJSON !== null) stats.keyFallbackRows++;
      if (kind === 'text' && targetJSON !== null) stats.targetFallbackRows++;
      const row = { id: Number(id), resourceId: resource.record.resourceId, resourceOrdinal: Number(ordinal),
        language: language.language, languageRaw: language.raw, languageBasis: language.basis, languageStatus: language.status,
        key, targetKind: kind, target };
      occurrenceHash.update(JSON.stringify(row) + '\n');
      if (Date.now() - lastProgress > 10000) { progress({ checkedRows: stats.rows }); lastProgress = Date.now(); }
    }
    contentHashes.occurrences = occurrenceHash.digest('hex');
    assert.deepEqual(contentHashes, report.contentHashes, 'SQL roundtrip differs from source streams');
    assert.equal(stats.rows, report.counts.occurrences); assert.equal(stats.textRows, report.counts.textRows);
    assert.equal(stats.structuredRows, report.counts.structuredRows); assert.deepEqual(stats, exported.stats);
    for (const { record, seen } of resources.values()) assert.equal(seen, record.rows);
    for (const language of languages.values()) assert.equal(language.seen, language.rows);
    assert.equal(resources.size, report.counts.resources); assert.equal(tables.size, report.counts.tables);
    assert.equal(resources.size, exported.resourceCount); assert.equal(tables.size, exported.tableCount);
    assert.equal(languages.size, exported.languageCount);
    await expect(layout.footer); assert.ok((await lines.next()).done, 'Trailing SQL is forbidden');
    assert.equal(await fileHash(path), exported.sqlSha256, 'SQL changed during audit');
    return { status: 'sql-file-full-roundtrip-verified', schema, packageManifest,
      sqlSha256: exported.sqlSha256, sqlReportSha256: sha256(sqlReportBytes), contentHashes, stats,
      resources: resources.size, tables: tables.size, bundles: bundles.size, languageProfiles: languages.size,
      quarantinedFiles: quarantine.size, quarantinedBytes: quarantineBytes,
      ...(durable ? { storage: 'logged', database: layout.database } : {}),
      imported: false, published: false, scope: 'Offline verification of COPY data and fixed SQL envelope; not a PostgreSQL execution or production-readiness test.' };
  } finally { await lines.return(); }
}
