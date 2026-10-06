import test from 'node:test';
import assert from 'node:assert/strict';
import { sqlText, searchQueries, searchSettings } from '../../scripts/database/verify-occurrence-search.mjs';
test('search verification encodes data separately from SQL syntax', () => {
  for (const value of ["O'Reilly\\'; DROP SCHEMA public; --", '設定', 'الإعدادات', '', '\t\n']) {
    assert.equal(sqlText(value), `convert_from(decode('${Buffer.from(value).toString('hex')}','hex'),'UTF8')`);
  }
  assert.throws(() => sqlText('\0')); assert.throws(() => sqlText('\ud800'));
});
test('strict search diagnostics disable automatic broadening only within the transaction', () => {
  const settings = searchSettings('ipsw_trial_fixture');
  assert.ok(settings.includes('SET LOCAL pgroonga.match_escalation_threshold=-1;'));
  assert.ok(settings.includes('SET LOCAL pgroonga.force_match_escalation=off;'));
  assert.ok(!settings.includes('ALTER'));
  assert.throws(() => searchSettings('public; DROP SCHEMA public'));
  assert.throws(() => searchSettings('localization_fixture'));
  assert.ok(searchSettings('localization_fixture', true).includes('search_path=localization_fixture,public'));
  assert.throws(() => searchSettings('ipsw_trial_fixture', true));
  assert.throws(() => searchSettings('public', true));
});
test('search comparisons use the same scoped predicate and refuse unsafe identifiers', () => {
  const q = searchQueries('ipsw_trial_fixture', [1, 2], '設定', 'occurrence_target_text_idx1');
  assert.ok(q.indexed.includes('language_id IN (1,2)'));
  assert.ok(q.reference.includes('language_id IN (1,2)'));
  assert.ok(q.reference.includes('AS MATERIALIZED')); assert.ok(q.page.includes('LIMIT 50'));
  for (const sql of Object.values(q)) { assert.ok(sql.includes('pgroonga_condition(')); assert.ok(sql.includes('index_name =>')); }
  assert.throws(() => searchQueries('public', [1], 'Open', 'index'));
  assert.throws(() => searchQueries('ipsw_trial_fixture', [1], 'Open', "index');DROP"));
  for (const ids of [[], [0], [32768], ['1); DROP TABLE x; --']]) assert.throws(() => searchQueries('ipsw_trial_fixture', ids, 'Open', 'index'));
});
