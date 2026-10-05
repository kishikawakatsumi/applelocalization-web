#!/usr/bin/env node
// Portable, read-only client. No repository dependencies or service credentials.
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

export class ClientError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}
const fail = (code, message, details) => { throw new ClientError(code, message, details); };
const invalid = message => fail('invalid_arguments', message);
const requireResponse = condition => {
  if (!condition) fail('invalid_response', 'Unexpected API response; no results accepted.');
};
const integer = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const strings = value => Array.isArray(value) && value.every(v => typeof v === 'string');
const componentPattern = id => new RegExp(`^${id}-(os|appos|systemos(?:-arm64e|-x86_64)?)$`);
const HELP = `Apple Localization read-only helper (Node.js 22+)
  datasets
  catalog --platform ios|macos --version MAJOR [--filter TEXT]
  search --platform ios|macos --version MAJOR --query TEXT
    (--language GROUP ... | --locale CODE ... | --all-languages)
    [--bundle NAME | --field key|localization|language|file|bundle]
    [--operator equal|notEqual|startsWith] [--bundle-path PATH]
    [--component ID] [--limit 1..50] [--page 1..10000]
Common: --base-url HTTPS_ORIGIN --timeout-ms 1000..45000 --help
Catalog also accepts --component, --limit and --page.
Normal search can omit --query when a bundle filter is supplied.
One GET per invocation; no retries or automatic pagination.
See ../references/api.md for semantics, privacy and provenance.
`;

export function parseCommand(argv) {
  const stringOptions = ['platform', 'version', 'query', 'bundle', 'bundle-path',
    'component', 'field', 'operator', 'limit', 'page', 'filter', 'timeout-ms', 'base-url'];
  let parsed;
  try {
    parsed = parseArgs({ args: argv, allowPositionals: true, tokens: true, options: {
      ...Object.fromEntries(stringOptions.map(key => [key, { type: 'string' }])),
      language: { type: 'string', multiple: true }, locale: { type: 'string', multiple: true },
      'all-languages': { type: 'boolean' }, help: { type: 'boolean' },
    } });
  } catch { invalid('Unknown option or missing option value. Use --help.'); }
  const { values: v, positionals, tokens } = parsed;
  const seen = new Set();
  for (const token of tokens.filter(t => t.kind === 'option')) {
    if (seen.has(token.name) && !['language', 'locale'].includes(token.name)) invalid(`Repeated --${token.name}.`);
    seen.add(token.name);
  }
  if (v.help) return { help: true };
  const command = positionals[0];
  if (positionals.length !== 1 || !['datasets', 'catalog', 'search'].includes(command)) invalid('Choose datasets, catalog or search. Use --help.');
  const allowed = new Set(['base-url', 'timeout-ms']);
  if (command !== 'datasets') ['platform', 'version', 'component', 'limit', 'page'].forEach(k => allowed.add(k));
  if (command === 'catalog') allowed.add('filter');
  if (command === 'search') ['query', 'bundle', 'bundle-path', 'field', 'operator', 'language', 'locale', 'all-languages'].forEach(k => allowed.add(k));
  for (const key of Object.keys(v)) if (!allowed.has(key)) invalid(`--${key} is not supported for ${command}.`);
  for (const value of Object.values(v).flat()) {
    if (typeof value === 'string' && (!value.length || !value.isWellFormed())) invalid('Option values must be nonempty, well-formed Unicode.');
  }
  const number = (key, fallback, max, min = 1) => {
    if (v[key] === undefined) return fallback;
    const n = Number(v[key]);
    if (!/^[0-9]+$/.test(v[key]) || !Number.isSafeInteger(n) || n < min || n > max) invalid(`--${key} must be ${min}..${max}.`);
    return n;
  };
  const limit = number('limit', 20, 50);
  const page = number('page', 1, 10000);
  const timeout = number('timeout-ms', 35000, 45000, 1000);
  let base;
  try { base = new URL(v['base-url'] ?? 'https://applelocalization.com'); }
  catch { invalid('Invalid --base-url.'); }
  if (base.username || base.password || base.search || base.hash || base.pathname !== '/' ||
      !(base.protocol === 'https:' || (base.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)))) {
    invalid('--base-url must be an HTTPS origin or HTTP loopback origin, without credentials, path, query or fragment.');
  }
  let id;
  if (command !== 'datasets') {
    if (!['ios', 'macos'].includes(v.platform) || !/^[1-9][0-9]{0,3}$/.test(v.version ?? '')) invalid('Specify --platform ios|macos and --version MAJOR.');
    id = v.platform + v.version;
    if (v.component && !componentPattern(id).test(v.component)) invalid('--component must belong to the selected dataset.');
  }
  if (command === 'search') {
    const selected = (v.language?.length ?? 0) + (v.locale?.length ?? 0);
    if ((!selected && !v['all-languages']) || (selected && v['all-languages'])) invalid('Choose explicit languages/locales OR --all-languages.');
    if (v.query?.length > 4096) invalid('--query exceeds 4096 UTF-16 code units.');
    if (v.field && !['key', 'localization', 'language', 'file', 'bundle'].includes(v.field)) invalid('Unknown --field.');
    if (v.operator && (!v.field || !['equal', 'notEqual', 'startsWith'].includes(v.operator))) invalid('--operator requires --field and a supported comparator.');
    if (v.field && v.bundle) invalid('Advanced search does not support --bundle; use --bundle-path.');
    if ((v.field && !v.query) || (!v.query && !v.bundle && !v['bundle-path'])) invalid('Supply --query (normal search also permits a bundle filter alone).');
    if (v['bundle-path'] && !v['bundle-path'].startsWith('/')) invalid('--bundle-path must be an absolute resource path.');
  }
  const url = new URL(command === 'datasets' ? '/api/datasets' : `/api/${v.platform}/${v.version}/${command}${v.field ? '/advanced' : ''}`, base);
  if (v.component) url.searchParams.set('component', v.component);
  if (command === 'search') {
    for (const [option, param] of [['query', 'q'], ['bundle', 'b'], ['bundle-path', 'bundle_path'], ['field', 'c']]) {
      if (v[option] !== undefined) url.searchParams.set(param, v[option]);
    }
    if (v.field) url.searchParams.set('o', v.operator ?? 'equal');
    for (const language of v.language ?? []) url.searchParams.append('l', language);
    for (const locale of v.locale ?? []) url.searchParams.append('locale', locale);
    url.searchParams.set('size', String(limit));
    url.searchParams.set('page', String(page));
  }
  return { command, options: v, id, base, url, limit, page, timeout };
}

export async function fetchJSON(url, { timeout, fetchImpl = fetch, maxBytes = 4 * 1024 * 1024 }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  let reader;
  try {
    const response = await fetchImpl(url, { method: 'GET', redirect: 'error',
      headers: { Accept: 'application/json' }, signal: controller.signal });
    if (!response.ok) {
      const status = response.status;
      const code = status === 429 ? 'rate_limit' : [503, 504].includes(status) ? 'service_unavailable' : 'http_error';
      const retryAfter = response.headers.get('retry-after');
      await response.body?.cancel();
      fail(code, `API returned HTTP ${status}; no results accepted.`, {
        status, ...(status === 429 && retryAfter ? { retry_after: retryAfter.slice(0, 128) } : {}),
      });
    }
    if (!/^application\/(?:json|[^;]+\+json)(?:;|$)/i.test(response.headers.get('content-type') ?? '')) {
      await response.body?.cancel();
      fail('invalid_response', 'Expected JSON, possibly received a proxy or authentication page.');
    }
    if (Number(response.headers.get('content-length')) > maxBytes) {
      await response.body?.cancel();
      fail('response_too_large', 'Response exceeds 4 MiB; narrow the query or reduce --limit.');
    }
    requireResponse(response.body);
    reader = response.body.getReader();
    const chunks = [];
    let length = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > maxBytes) fail('response_too_large', 'Response exceeds 4 MiB; narrow the query or reduce --limit.');
      chunks.push(value);
    }
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
    catch { fail('invalid_response', 'Malformed JSON response; no results accepted.'); }
  } catch (error) {
    if (error instanceof ClientError) throw error;
    if (controller.signal.aborted) fail('timeout', 'Request timed out; narrow the query before trying again.');
    fail('connection_failed', 'Could not complete the request. Check connectivity and the origin; redirects are not followed.');
  } finally {
    clearTimeout(timer);
    if (reader) { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  }
}

function dataset(value, expected) {
  requireResponse(object(value) && typeof value.id === 'string' && /^(ios|macos)[1-9][0-9]*$/.test(value.id) &&
    typeof value.version === 'string' && /^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/.test(value.version) &&
    typeof value.build === 'string' && /^[0-9]+[A-Za-z][0-9]+[a-z]?$/.test(value.build));
  requireResponse(!expected || value.id === expected);
  const platform = value.id.startsWith('macos') ? 'macos' : 'ios';
  requireResponse(value.id === platform + value.version.split('.')[0]);
  return { id: value.id, platform, version: value.version, build: value.build };
}

export function formatResponse(config, body) {
  const { command, options: v, id, base, url, limit, page } = config;
  requireResponse(object(body));
  const links = { api: url.href };
  if (command === 'datasets') {
    requireResponse(Array.isArray(body.datasets));
    return { datasets: body.datasets.map(d => {
      const result = dataset(d);
      requireResponse(Array.isArray(d.components) && d.components.every(c => object(c) && componentPattern(d.id).test(c.key)));
      return { ...result, components: d.components.map(c => c.key) };
    }), links };
  }
  if (command === 'catalog') {
    const target = dataset(body.target, id);
    requireResponse(strings(body.languages) && object(body.languageGroups) &&
      Object.values(body.languageGroups).every(strings) && strings(body.bundles) && Array.isArray(body.components) && integer(body.total));
    const bundles = body.bundles.filter(b => !v.filter || b.toLowerCase().includes(v.filter.toLowerCase()));
    return { dataset: target, total_rows: body.total, languages: body.languages, languageGroups: body.languageGroups,
      components: body.components.map(c => {
        requireResponse(object(c) && componentPattern(id).test(c.key) && integer(c.rows) && typeof c.sourceId === 'string');
        return { key: c.key, rows: c.rows, source_id: c.sourceId };
      }), bundles: bundles.slice((page - 1) * limit, page * limit), matching_bundles: bundles.length,
      page, limit, next_page: page * limit < bundles.length ? page + 1 : null, links };
  }
  requireResponse(object(body.meta));
  const target = dataset({ id: body.meta.dataset, version: body.meta.version, build: body.meta.build }, id);
  requireResponse(Array.isArray(body.data) && body.data.length <= limit && integer(body.total) &&
    body.last_page === Math.ceil(body.total / limit));
  const rows = body.data.map(row => {
    requireResponse(object(row) && row.dataset === id && componentPattern(id).test(row.component) &&
      (!v.component || row.component === v.component) && integer(row.id) && typeof row.source === 'string' &&
      typeof row.language === 'string' && typeof row.bundle_name === 'string' && typeof row.file_name === 'string' &&
      ['text', 'structured'].includes(row.target_kind) &&
      (row.target_kind === 'text' ? typeof row.target_value === 'string' : row.target_value !== undefined) && object(row.provenance));
    const p = row.provenance;
    requireResponse(typeof p.source_id === 'string' && (p.table_id === null || typeof p.table_id === 'string') &&
      typeof p.resource_id === 'string' && object(p.language));
    return { id: row.id, component: row.component,
      context_id: p.table_id === null ? null : JSON.stringify([id, target.build, row.component, p.table_id, row.source]),
      key: row.source, localization: row.target_value, value_kind: row.target_kind,
      locale: row.language, bundle: row.bundle_name, file: row.file_name,
      provenance: Object.fromEntries(['source_id', 'table_id', 'resource_id', 'resource_status', 'sha256',
        'image_path', 'resource_path', 'bundle_path', 'bundle_assignment', 'language'].map(k => [k, p[k]])) };
  });
  const web = new URL(`/${v.platform}/${v.version}`, base);
  for (const [key, value] of url.searchParams) if (['q', 'b', 'c', 'o', 'l', 'locale'].includes(key)) web.searchParams.append(key, value);
  if (v['all-languages']) web.searchParams.append('l', '');
  links.web_search = v.query || v.bundle ? web.href : null;
  links.web_scope_matches = Boolean(links.web_search && !v.component && !v['bundle-path'] && page === 1);
  return { dataset: target, rows, pagination: { page, limit, returned: rows.length, total_rows: body.total,
    last_page: body.last_page, next_page: page < body.last_page ? page + 1 : null },
    context_completeness: 'not-guaranteed', links };
}

export async function execute(argv, fetchImpl = fetch) {
  const config = parseCommand(argv);
  if (config.help) return HELP;
  return formatResponse(config, await fetchJSON(config.url, { timeout: config.timeout, fetchImpl }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const result = await execute(process.argv.slice(2));
    process.stdout.write(typeof result === 'string' ? result : JSON.stringify(result, null, 2) + '\n');
  } catch (error) {
    const known = error instanceof ClientError;
    process.stderr.write(JSON.stringify({ error: { code: known ? error.code : 'internal_error',
      message: known ? error.message : 'Unexpected client failure.', ...(known ? error.details : {}) } }) + '\n');
    process.exitCode = 1;
  }
}
