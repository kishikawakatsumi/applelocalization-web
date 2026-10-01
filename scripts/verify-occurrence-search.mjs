// Read-only search checks for an isolated occurrence schema; no legacy-corpus speed claims.
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { psqlLines, validateSchema, postgresText, occurrenceSQLLayout, stagingDatabase } from './occurrence-staging.mjs';
import { localDockerOnly } from './load-occurrence-staging.mjs';

export function sqlText(value) {
  assert.ok(postgresText(value));
  return `convert_from(decode('${Buffer.from(value).toString('hex')}','hex'),'UTF8')`;
}
function validateSearchSchema(schema, durable) {
  if (durable) occurrenceSQLLayout({ schema, durable, database: stagingDatabase });
  else validateSchema(schema);
}
export function searchSettings(schema, durable = false) {
  validateSearchSchema(schema, durable);
  // Strict diagnostic mode, not a production configuration change. Disable result-count-dependent broadening.
  return `SET LOCAL search_path=${schema},public; SET LOCAL pgroonga.match_escalation_threshold=-1; SET LOCAL pgroonga.force_match_escalation=off;`;
}
export function searchQueries(schema, ids, term, indexName, durable = false) {
  validateSearchSchema(schema, durable);
  assert.match(indexName, /^[a-z][a-z0-9_]{0,62}$/);
  assert.ok(ids.length && ids.every(id => Number.isSafeInteger(id) && id > 0 && id <= 32767));
  // Without this explicit configuration, PGroonga may use different tokenization in a sequential scan.
  // Caller sets the validated schema in transaction-local search_path. This is tested on PGroonga 4.0.4.
  const condition = `pgroonga_condition(${sqlText(term)},index_name => ${sqlText(indexName)})`;
  const filter = `language_id IN (${ids.join(',')})`, match = `target_text &@ ${condition}`;
  const digest = `count(*)::text AS count,encode(sha256(convert_to(coalesce(string_agg(id::text,',' ORDER BY id),''),'UTF8')),'hex') AS ids_sha256`;
  return {
    indexed: `SELECT ${digest} FROM ${schema}.occurrence WHERE ${filter} AND ${match}`,
    reference: `WITH language_rows AS MATERIALIZED (SELECT id,target_text FROM ${schema}.occurrence WHERE ${filter}) SELECT ${digest} FROM language_rows WHERE ${match}`,
    page: `WITH page AS MATERIALIZED (SELECT id,resource_id,key_text,target_text FROM ${schema}.occurrence WHERE ${filter} AND ${match} ORDER BY id LIMIT 50) SELECT p.id,p.key_text,p.target_text,b.path AS bundle_path FROM page p JOIN ${schema}.resource r ON r.id=p.resource_id JOIN ${schema}.bundle b ON b.id=r.bundle_id ORDER BY p.id`,
    view: `SELECT id,key_text,target_text,bundle_path FROM ${schema}.search_rows WHERE language IN (SELECT code FROM ${schema}.language WHERE id IN (${ids.join(',')})) AND ${match} ORDER BY id LIMIT 50`,
  };
}

async function runQuery(sql, settings = '', lines = psqlLines) {
  const results = [];
  for await (const line of lines(`BEGIN READ ONLY; SET LOCAL statement_timeout='120s'; SET LOCAL work_mem='32MB'; ${settings} SELECT coalesce(json_agg(q),'[]'::json) FROM (${sql}) q; COMMIT;`)) results.push(line);
  return JSON.parse(results.join('\n'));
}
async function runExplain(sql, settings = '', query = psqlLines) {
  const lines = [];
  for await (const line of query(`BEGIN READ ONLY; SET LOCAL statement_timeout='120s'; ${settings} EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${sql}; COMMIT;`)) lines.push(line);
  return JSON.parse(lines.join('\n'))[0];
}
const forcedIndex = 'SET LOCAL enable_seqscan=off;';
const cases = [['en', 'Settings'], ['ja', '設定'], ['fr', 'Réglages'], ['de', 'Einstellungen'], ['es', 'Configuración'],
  ['ko', '설정'], ['zh_CN', '设置'], ['ar', 'الإعدادات'], ['ru', 'Настройки'], ['pt_BR', 'Ajustes']];

export async function verifyOccurrenceSearch({ schema, verification, durable = false, progress = () => {}, lines = psqlLines }) {
  validateSearchSchema(schema, durable); localDockerOnly();
  const scope = searchSettings(schema, durable);
  const query = (sql, settings = '') => runQuery(sql, scope + settings, lines);
  const explain = (sql, settings = '') => runExplain(sql, scope + settings, lines);
  const expected = JSON.parse(await readFile(verification));
  assert.equal(expected.status, durable ? 'durable-release-sql-verified-not-imported' : 'release-staging-sql-verified-not-imported'); assert.equal(expected.schema, schema);
  const pack = await query(`SELECT manifest_sha256,report_json FROM ${schema}.package`);
  assert.equal(pack.length, 1); assert.equal(pack[0].manifest_sha256, expected.packageManifest);
  const report = JSON.parse(pack[0].report_json); assert.equal(report.counts.occurrences, expected.stats.rows);
  const environment = await query(`SELECT version(),(SELECT extversion FROM pg_extension WHERE extname='pgroonga') AS pgroonga`);
  const indexes = await query(`SELECT c.relname,a.amname,i.indisvalid,i.indisready,t.relname AS table_name,pg_get_indexdef(i.indexrelid,1,true) AS first_column FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_am a ON a.oid=c.relam JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${sqlText(schema)} ORDER BY c.relname`);
  assert.ok(indexes.every(i => i.indisvalid && i.indisready)); assert.equal(indexes.filter(i => i.amname === 'pgroonga').length, 2);
  const targetIndexes = indexes.filter(i => i.amname === 'pgroonga' && i.table_name === 'occurrence' && i.first_column === 'target_text');
  assert.equal(targetIndexes.length, 1);
  const profiles = await query(`SELECT l.id,l.code,l.raw,l.basis,l.status,l.expected_rows::text,o.id::text AS sample_id,
    CASE WHEN o.id IS NULL THEN NULL ELSE EXISTS (SELECT 1 FROM ${schema}.occurrence x WHERE x.language_id=l.id AND x.target_text=o.target_text) END AS exact_found,
    CASE WHEN o.id IS NULL THEN NULL ELSE EXISTS (SELECT 1 FROM ${schema}.search_rows v WHERE v.id=o.id AND v.language=l.code AND v.target_text=o.target_text) END AS view_found
    FROM ${schema}.language l LEFT JOIN LATERAL (SELECT id,target_text FROM ${schema}.occurrence WHERE language_id=l.id AND target_text IS NOT NULL AND length(target_text) BETWEEN 1 AND 128 ORDER BY id LIMIT 1) o ON true ORDER BY l.id`);
  assert.equal(profiles.length, expected.languageProfiles);
  // A profile containing only long strings is not an absent language. Retry only
  // those profiles, returning IDs/booleans rather than potentially huge text.
  for (const profile of profiles.filter(p => p.sample_id === null)) {
    const [fallback] = await query(`SELECT o.id::text AS sample_id,
      EXISTS (SELECT 1 FROM ${schema}.occurrence x WHERE x.language_id=${Number(profile.id)} AND x.target_text=o.target_text) AS exact_found,
      EXISTS (SELECT 1 FROM ${schema}.search_rows v WHERE v.id=o.id AND v.target_text=o.target_text AND v.language=${sqlText(profile.code)}) AS view_found
      FROM (SELECT id,target_text FROM ${schema}.occurrence WHERE language_id=${Number(profile.id)} AND target_text IS NOT NULL AND length(target_text)>128 ORDER BY id LIMIT 1) o`);
    if (fallback) Object.assign(profile, fallback, { sampleBasis: 'long-text-fallback' });
  }
  for (const profile of profiles) if (profile.sample_id !== null) { assert.equal(profile.exact_found, true); assert.equal(profile.view_found, true); }
  const measurements = [];
  for (const [language, term] of cases) {
    const ids = profiles.filter(p => p.code === language).map(p => p.id);
    assert.ok(ids.length, `Expected search profile missing: ${language}`);
    const sql = searchQueries(schema, ids, term, targetIndexes[0].relname, durable);
    const indexed = await query(sql.indexed, forcedIndex), reference = await query(sql.reference);
    const matchingIdsAgree = JSON.stringify(indexed) === JSON.stringify(reference);
    assert.ok(Number(indexed[0].count) > 0, `No fulltext hits: ${language}`);
    const page = await query(sql.page), view = await query(sql.view);
    const pagesAgree = JSON.stringify(page) === JSON.stringify(view);
    const indexedPlan = await explain(sql.indexed, forcedIndex);
    assert.ok(indexes.filter(i => i.amname === 'pgroonga').some(i => JSON.stringify(indexedPlan.Plan).includes(i.relname)), 'Fulltext plan must use PGroonga');
    const pagePlan = await explain(sql.page);
    const result = { language, term, matches: indexed[0].count, idsSha256: indexed[0].ids_sha256,
      reference: reference[0], matchingIdsAgree, pagesAgree,
      pageRows: page.length, indexMilliseconds: indexedPlan['Execution Time'], pageMilliseconds: pagePlan['Execution Time'], indexedPlan, pagePlan };
    measurements.push(result); progress({ language, matches: result.matches, referenceMatches: reference[0].count, matchingIdsAgree, pagesAgree, pageMilliseconds: result.pageMilliseconds });
  }
  const variants = await query(`SELECT o.target_text,count(*)::text AS rows,count(DISTINCT r.bundle_id)::text AS bundles FROM ${schema}.occurrence o JOIN ${schema}.language l ON l.id=o.language_id JOIN ${schema}.resource r ON r.id=o.resource_id WHERE o.key_text='Open' AND l.code='ja' GROUP BY o.target_text ORDER BY o.target_text`);
  assert.ok(variants.filter(v => v.target_text !== null).length > 1, 'Expected contextual translations of Open');
  const sizes = await query(`SELECT pg_total_relation_size(c.oid)::text AS bytes,c.relname FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind='r' AND n.nspname=${sqlText(schema)} ORDER BY c.relname`);
  return { status: measurements.every(m => m.matchingIdsAgree && m.pagesAgree) ? 'occurrence-search-verified' : 'occurrence-search-discrepancies', schema, packageManifest: expected.packageManifest,
    environment, indexes, conditionPolicy: 'explicit-index-tokenization-without-auto-escalation', transactionSettings: scope, languageProfiles: profiles, profilesWithSample: profiles.filter(p => p.sample_id !== null).length,
    profilesWithoutSample: profiles.filter(p => p.sample_id === null), measurements, variants, sizes,
    limitations: ['All profiles checked for a searchable exemplar, preferring short text and falling back to long text; profiles without one are listed, not silently considered tested.',
      'Ten fixed fulltext cases compare every matching ID/count against the same language corpus materialized without its fulltext index.',
      'One warm execution plan per case is diagnostic, not a production benchmark or comparison against the legacy corpus.',
      'Key is a resource key, not necessarily a source sentence. No automatic pairing, deduplication, API deployment or production readiness.'], published: false };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values: v } = parseArgs({ options: { ...Object.fromEntries(['schema', 'verification', 'output'].map(k => [k, { type: 'string' }])), durable: { type: 'boolean', default: false } } });
  assert.ok(v.schema && v.verification && v.output);
  await writeFile(v.output, JSON.stringify({ status: 'running', schema: v.schema }) + '\n', { flag: 'wx' });
  try {
    const result = await verifyOccurrenceSearch({ ...v, progress: x => console.log(JSON.stringify(x)) });
    await writeFile(v.output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify({ status: result.status, profilesWithSample: result.profilesWithSample, cases: result.measurements.length }));
    if (result.status !== 'occurrence-search-verified') process.exitCode = 1;
  } catch (error) { await writeFile(v.output, JSON.stringify({ status: 'failed', error: String(error) }) + '\n'); throw error; }
}
