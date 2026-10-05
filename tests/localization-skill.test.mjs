import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { ClientError, parseCommand, fetchJSON, formatResponse, execute } from '../skills/apple-localization/scripts/search.mjs';

const search = ['search', '--platform', 'macos', '--version', '27', '--query', 'tab', '--all-languages'];
const target = { id: 'macos27', platform: 'macOS', version: '27.0', build: '26A100',
  components: [{ key: 'macos27-os', schema: 'private_schema', packageManifest: 'private_manifest' }] };
const makeRow = (overrides = {}) => ({ id: 1, dataset: 'macos27', component: 'macos27-os',
  source: 'Tab', target_kind: 'text', target_value: 'タブ', language: 'ja',
  bundle_name: 'Terminal.app', file_name: 'Localizable.strings',
  provenance: { source_id: 'macOS-27.0-26A100-os', table_id: 'table-a', resource_id: 'resource-a',
    resource_status: 'parsed', sha256: 'a'.repeat(64), image_path: '/Applications/Terminal.app/ja.lproj/Localizable.strings',
    resource_path: 'ja.lproj/Localizable.strings', bundle_path: '/Applications/Terminal.app', bundle_assignment: 'explicit',
    language: { raw: 'ja', basis: 'lproj', status: 'resolved' } }, ...overrides });
const response = (rows = [makeRow()], total = rows.length, limit = 20) => ({ data: rows, total,
  last_page: Math.ceil(total / limit), meta: { dataset: 'macos27', version: '27.0', build: '26A100' } });
const errorCode = code => error => error instanceof ClientError && error.code === code;

test('encodes reserved characters without changing query or language selections', () => {
  const query = '  A&B + # / 日本語 %@\n';
  const c = parseCommand(['search', '--platform', 'ios', '--version', '18', '--query', query,
    '--language', 'English', '--language', 'Japanese', '--locale', 'en-AU', '--bundle', 'A&B.app']);
  assert.equal(c.url.pathname, '/api/ios/18/search');
  assert.equal(c.url.searchParams.get('q'), query);
  assert.equal(c.url.searchParams.get('b'), 'A&B.app');
  assert.deepEqual(c.url.searchParams.getAll('l'), ['English', 'Japanese']);
  assert.deepEqual(c.url.searchParams.getAll('locale'), ['en-AU']);
  assert.equal(c.url.hash, '');
  assert.equal(c.url.searchParams.get('size'), '20');
});

test('advanced key lookup, explicit all languages and bundle-only normal lookup', () => {
  const c = parseCommand([...search, '--field', 'key', '--bundle-path', '/Applications/Terminal.app']);
  assert.equal(c.url.pathname, '/api/macos/27/search/advanced');
  assert.equal(c.url.searchParams.get('o'), 'equal');
  assert.equal(c.url.searchParams.has('l'), false);
  const b = parseCommand(['search', '--platform', 'macos', '--version', '27', '--bundle', 'Terminal.app', '--all-languages']);
  assert.equal(b.url.searchParams.has('q'), false);
});

test('project and stored locale spellings remain distinct through requests and evidence', async () => {
  const requested = ['en-AU', 'en_AU'];
  const result = await execute(['search', '--platform', 'macos', '--version', '27', '--query', 'Close tab',
    ...requested.flatMap(locale => ['--locale', locale])], async url => {
    assert.deepEqual(url.searchParams.getAll('locale'), requested);
    const row = makeRow({ source: 'Close tab', language: 'en_AU', target_value: 'Close tab' });
    row.provenance.language.raw = 'en_AU';
    return Response.json(response([row]));
  });
  assert.equal(result.rows[0].locale, 'en_AU');
  assert.equal(result.rows[0].provenance.language.raw, 'en_AU');
  assert.deepEqual(new URL(result.links.web_search).searchParams.getAll('locale'), requested);
});

test('rejects incomplete and silently ineffective conditions before network access', async () => {
  const cases = [[], ['search'], [...search, '--wat'], [...search, '--limit', '51'],
    [...search, '--page', '0'], [...search, '--limit', '2', '--limit', '3'],
    [...search, '--language', 'English'], [...search, '--field', 'key', '--bundle', 'Terminal.app'],
    [...search, '--operator', 'equal'], [...search, '--component', 'ios27-os'],
    [...search, '--filter', 'Terminal'], [...search, '--locale', ''],
    [...search.slice(0, 5), '--query', 'tab'],
    [...search.slice(0, 5), '--query', 'x'.repeat(4097), '--all-languages'],
    ['catalog', '--platform', 'macos', '--version', '27.0'], ['datasets', '--limit', '5'],
    [...search, '--bundle-path', 'relative/path'], [...search, '--timeout-ms', '999']];
  for (const args of cases) {
    await assert.rejects(execute(args, () => assert.fail('must not fetch')), errorCode('invalid_arguments'), JSON.stringify(args));
  }
});

test('only secure origins or explicit local HTTP, without credentials or URL extras', () => {
  for (const base of ['https://example.com', 'http://127.0.0.1:8084', 'http://localhost:8084', 'http://[::1]:8084']) {
    assert.equal(parseCommand([...search, '--base-url', base]).url.origin, base);
  }
  for (const base of ['http://example.com', 'ftp://example.com', 'https://user:password@example.com',
    'https://example.com/path', 'https://example.com/?token=secret', 'https://example.com/#fragment']) {
    assert.throws(() => parseCommand([...search, '--base-url', base]), errorCode('invalid_arguments'));
  }
});

test('dataset discovery omits SQL internals; catalog limits bundles, retains all locales', () => {
  const d = formatResponse(parseCommand(['datasets']), { datasets: [target] });
  assert.deepEqual(d.datasets[0].components, ['macos27-os']);
  assert.ok(!JSON.stringify(d).includes('private_'));
  const c = parseCommand(['catalog', '--platform', 'macos', '--version', '27', '--filter', 'APP', '--limit', '1']);
  const result = formatResponse(c, { target, total: 99, languages: ['en', 'ja', 'or'],
    languageGroups: { English: ['en'], Japanese: ['ja'], Oriya: ['or'] },
    bundles: ['/Applications/A.app', '/Applications/B.app', '/System/C.framework'],
    components: [{ key: 'macos27-os', rows: 99, sourceId: 'macOS-27.0-26A100-os' }] });
  assert.deepEqual(result.bundles, ['/Applications/A.app']);
  assert.equal(result.matching_bundles, 2);
  assert.equal(result.next_page, 2);
  assert.deepEqual(result.languages, ['en', 'ja', 'or']);
  assert.deepEqual(result.languageGroups.Oriya, ['or']);
});

test('preserves structured values, invisible characters and distinct resource contexts', () => {
  const first = makeRow({ target_value: '%1$@\n\t A\u0000𠮷' });
  const otherLanguage = makeRow({ id: 2, language: 'en', target_value: 'Tab' });
  const otherTable = makeRow({ provenance: { ...first.provenance, table_id: 'table-b' } });
  const otherComponent = makeRow({ component: 'macos27-appos' });
  const unknownTable = makeRow({ provenance: { ...first.provenance, table_id: null } });
  const plural = makeRow({ id: 3, target_kind: 'structured', target_value: { items: { one: '%d item', other: '%d items' } } });
  const body = response([first, otherLanguage, otherTable, otherComponent, unknownTable, plural]);
  const r = formatResponse(parseCommand(search), body);
  assert.equal(r.rows.length, 6);
  assert.equal(r.rows[0].localization, first.target_value);
  assert.deepEqual(r.rows[5].localization, plural.target_value);
  assert.equal(r.rows[0].context_id, r.rows[1].context_id);
  assert.notEqual(r.rows[0].context_id, r.rows[2].context_id);
  assert.notEqual(r.rows[0].context_id, r.rows[3].context_id);
  assert.equal(r.rows[4].context_id, null);
  assert.deepEqual(r.rows[0].provenance, first.provenance);
  assert.equal(r.context_completeness, 'not-guaranteed');
  assert.equal(r.links.web_scope_matches, true);
  assert.equal(new URL(r.links.web_search).searchParams.get('l'), '');
});

test('pagination never auto-fetches; scoped web links are not presented as exact evidence', async () => {
  let calls = 0;
  const r = await execute([...search, '--component', 'macos27-os', '--limit', '1'], async (url, options) => {
    calls++;
    assert.equal(options.redirect, 'error');
    assert.equal(options.method, 'GET');
    assert.deepEqual(options.headers, { Accept: 'application/json' });
    return Response.json(response([makeRow()], 3, 1));
  });
  assert.equal(calls, 1);
  assert.equal(r.pagination.next_page, 2);
  assert.equal(r.links.web_scope_matches, false);
  assert.ok(r.links.api.includes('component=macos27-os'));
  const empty = formatResponse(parseCommand([...search, '--page', '5']), response([], 3));
  assert.equal(empty.pagination.total_rows, 3);
  assert.equal(empty.pagination.next_page, null);
  assert.equal(empty.links.web_scope_matches, false);
});

test('rejects wrong datasets, components, broken provenance and malformed pagination', () => {
  for (const body of [{}, { ...response(), meta: { dataset: 'ios27', version: '27.0', build: '26A100' } },
    response([makeRow({ dataset: 'ios27' })]), response([makeRow({ component: 'ios27-os' })]),
    response([makeRow({ provenance: {} })]), { ...response(), last_page: 999 },
    response([makeRow({ target_kind: 'unknown' })])]) {
    assert.throws(() => formatResponse(parseCommand(search), body), errorCode('invalid_response'));
  }
});

test('empty success is distinct from HTTP and connection errors, with no retry', async () => {
  const empty = await execute(search, async () => Response.json(response([])));
  assert.deepEqual(empty.rows, []);
  for (const [status, code] of [[400, 'http_error'], [404, 'http_error'], [429, 'rate_limit'], [503, 'service_unavailable'], [504, 'service_unavailable']]) {
    let calls = 0;
    await assert.rejects(execute(search, async () => {
      calls++;
      return new Response('Not query evidence', { status, headers: { 'Retry-After': '60' } });
    }), error => errorCode(code)(error) && error.details.status === status && (status !== 429 || error.details.retry_after === '60'));
    assert.equal(calls, 1);
  }
  await assert.rejects(execute(search, async () => { throw new TypeError('secret network details'); }), errorCode('connection_failed'));
});

test('rejects HTML, malformed JSON, invalid UTF-8 and oversized bodies', async () => {
  for (const makeResponse of [() => new Response('<html>challenge</html>'),
    () => new Response('{bad', { headers: { 'Content-Type': 'application/json' } }),
    () => new Response(new Uint8Array([255]), { headers: { 'Content-Type': 'application/json' } })]) {
    await assert.rejects(execute(search, async () => makeResponse()), errorCode('invalid_response'));
  }
  for (const headers of [{ 'Content-Type': 'application/json' }, { 'Content-Type': 'application/json', 'Content-Length': '99' }]) {
    await assert.rejects(fetchJSON(new URL('https://example.com'), { timeout: 1000, maxBytes: 8,
      fetchImpl: async () => new Response('0123456789', { headers }) }), errorCode('response_too_large'));
  }
});

test('timeout covers response headers and body, not just the initial fetch', async () => {
  for (const bodyStalls of [false, true]) {
    await assert.rejects(fetchJSON(new URL('https://example.com'), { timeout: 20, fetchImpl: async (_url, { signal }) => {
      if (!bodyStalls) return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      return new Response(new ReadableStream({ start(controller) {
        signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
      } }), { headers: { 'Content-Type': 'application/json' } });
    } }), errorCode('timeout'));
  }
});

test('standalone CLI help works outside the repository and invalid usage uses JSON stderr', () => {
  const script = fileURLToPath(new URL('../skills/apple-localization/scripts/search.mjs', import.meta.url));
  const help = execFileSync(process.execPath, [script, '--help'], { cwd: tmpdir(), encoding: 'utf8' });
  assert.match(help, /One GET/);
  assert.throws(() => execFileSync(process.execPath, [script, 'search'], { encoding: 'utf8', stdio: 'pipe' }), error => {
    assert.equal(error.status, 1);
    assert.equal(error.stdout, '');
    assert.equal(JSON.parse(error.stderr).error.code, 'invalid_arguments');
    return true;
  });
});
