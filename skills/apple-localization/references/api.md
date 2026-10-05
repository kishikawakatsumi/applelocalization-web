# Apple Localization API and helper

This documents the existing read-only API; no MCP server or new backend endpoint
is required. Production base URL: `https://applelocalization.com`.

## Helper (Node.js 22+)

Run from any directory, using the installed skill's absolute path:

```sh
node <skill-directory>/scripts/search.mjs datasets
node <skill-directory>/scripts/search.mjs catalog --platform macos --version 27 --filter Terminal
node <skill-directory>/scripts/search.mjs search --platform macos --version 27 --query 'tab' --bundle Terminal.app --language English --language Japanese --limit 20
node <skill-directory>/scripts/search.mjs search --platform macos --version 27 --query 'Open' --field key --operator equal --language English --language Japanese
```

These versions and languages are examples. Discover datasets and honor the user's
target. The helper requires a major version and an explicit language selection
for searches: repeated `--language`, repeated `--locale`, or `--all-languages`.
It never silently selects English/Japanese or the latest OS.

| Option | Meaning |
| --- | --- |
| `--platform ios\|macos`, `--version 27` | Required for catalog/search; major version, not `27.0.1` |
| `--query TEXT` | Exact input preserved, including spaces and URL-reserved characters |
| `--language English` | Repeatable display group; use catalog.languageGroups |
| `--locale en-AU` | Repeatable exact stored code; union with language groups |
| `--all-languages` | Explicitly omit API language filters; incompatible with selections |
| `--bundle Terminal.app` | Normal search basename filter; different paths may share a name |
| `--bundle-path /Applications/Example.app` | Exact path, both normal and advanced |
| `--component macos27-os` | Restrict to a component of the selected dataset |
| `--field key\|localization\|language\|file\|bundle` | Select advanced search |
| `--operator equal\|notEqual\|startsWith` | Advanced comparator; default equal |
| `--limit 20`, `--page 1` | 1–50 rows/items per invocation; page 1–10,000; no auto-pagination |
| `--filter TEXT` | Catalog bundle-path substring only; client-side, case-insensitive |
| `--timeout-ms 35000` | 1,000–45,000 ms for headers and body together |
| `--base-url URL` | HTTPS origin, or HTTP loopback such as `http://127.0.0.1:8084` |
| `--help` | Local usage; no network request |

One invocation makes at most one GET, never retries or follows redirects, and
accepts at most 4 MiB of response body. It does not read app files, upload files,
write files, install dependencies or use service credentials. stdout is JSON;
errors are JSON on stderr with a nonzero exit status. Empty successful results
have exit status zero. `--help` prints plain text.

Lowering `--limit` bounds returned data, **not the API's COUNT cost**. Do not launch
bulk concurrent requests. On `rate_limit`, honor `retry_after` if provided and
stop the current batch. On timeout, narrow the query rather than looping retries.

## HTTP endpoints

All endpoints below accept GET and return JSON with `Cache-Control: no-store`.

| Endpoint | Result |
| --- | --- |
| `/api/datasets` | `datasets` with IDs, platform, version, build and components |
| `/api/{ios\|macos}/{major}/catalog` | Target, raw languages, languageGroups, bundle full paths, components, total |
| `/api/{ios\|macos}/{major}/search` | Normal search with context expansion |
| `/api/{ios\|macos}/{major}/search/advanced` | Comparison search; only matching rows |

The HTTP API also allows omission of `{major}` to resolve the latest dataset.
The helper deliberately requires a major for reproducible review scope. The exact
patch/build can still change when a dataset is updated; keep returned provenance.

### Parameters

- `q`: query, at most 4,096 UTF-16 code units. Normal search needs `q`, `b` or
  `bundle_path`; advanced needs nonempty `q`. No whitespace trimming is performed.
- `l`: repeated language-group name or raw code. `locale`: repeated exact code.
  With neither, the API searches all languages. Their selections are combined.
  Unknown nonempty selections yield no matching rows, not an unfiltered search.
- `b`: bundle basename in normal search. **Advanced ignores this legacy parameter**;
  the helper rejects `--bundle` with `--field`. Use `bundle_path` instead.
- `bundle_path`: full path filter in either mode.
- `component`: one component belonging to the requested OS major. Unknown is 400.
- `c`: advanced field: `key`, `localization`, `language`, `file`, `bundle`.
- `o`: advanced comparison: `equal`, `notEqual`, `startsWith`.
- `page`: positive integer. `size`: positive integer, capped at 200 by the API.
  The helper uses a lower maximum of 50.

### Search semantics

Normal search uses PGroonga on `target_text` and serialized `target_json`, then
includes selected-language rows with the same resource table and exact key.
Returned rows need not each contain the query. It is not an English-to-target
translation lookup, semantic similarity search, or relevance-ranked list.
Key is a resource identifier and is not necessarily English source text.
Keys in the reviewed app need not match Apple's keys. Use normal value search
to discover examples, then advanced Key to revisit a known resource key; zero
matches for a key do not establish absence of that wording in values.

Language filtering affects both matching and returned context rows; separate
match-language and output-language filters are not implemented. Include the
desired languages in the same search and inspect the actual returned values.

Advanced Key compares the resource key. Advanced Localization compares text-kind
values only, not entire structured dictionaries. Language compares stored codes,
File compares basename, Bundle compares effective bundle name. Prefix uses escaped
LIKE, not user-supplied wildcard patterns. Full text/prefix require PostgreSQL-
compatible text. Structured JSON may match dictionary keys as well as values.

OS and major versions never mix in one request. OS/AppOS/SystemOS (and architecture
components where present) of the same release are combined in a fixed order.
Identical text in different resources/components is not deduplicated.

### Responses, provenance and limits

Search returns `data`, `total`, `last_page`, and `meta` (dataset, exact version,
build, component counts, grouping). `total` is result **rows after expansion**,
not unique keys or unique translations. Each row carries component-local `id`,
`group_id`, `source` (Key), `target`, `target_kind`, `target_value`, language,
bundle/file names and `provenance`.

The helper returns compact `rows` without altering key/localization contents.
It retains source/table/resource IDs, original resource hash/path, effective
bundle path/assignment, resource status and language basis/status. Full ownership
evidence remains available from `links.api`. `context_id` is a JSON tuple of
dataset, build, component, table ID and key, or null when the table is unknown.
It is a descriptive identity, not an implemented detail-fetch endpoint.

`pagination.next_page` is explicit. Pages can split a context, and advanced search
does not expand other languages. `context_completeness` is therefore
`not-guaranteed`. An empty page after the end is not an empty corpus. Do not infer
absent translations from a partial response or pair rows by adjacency alone.

`links.web_search` uses supported UI conditions and is **not a row permalink**.
The UI does not restore `bundle_path`, `component`, or a result page; check
`links.web_scope_matches` and retain the API URL/provenance. For searches using
only a full bundle path, `web_search` is null rather than an unrelated UI link.
A major-version link can
show a different patch release after a data update. For exact evidence record
dataset/version/build/component/source ID/resource ID/hash/key/locale together.

Catalog output limits only bundle paths locally, with `matching_bundles` and
`next_page`. Languages and group aliases are retained. Dataset output omits SQL
schema/package internals; raw API output remains accessible via its URL.

### Errors

HTTP 400 means invalid conditions, 404 an unknown route/dataset, 405 an unsupported
method, 503 may indicate a database timeout, and 500 a server failure. A proxy may
also return 429, 502 or 504, or an HTML challenge. The helper rejects non-JSON,
malformed or wrong-dataset responses instead of presenting them as zero matches.
Network errors, body-size limits and timeouts are distinct helper errors.

### Interpretation and disclosure

English/French/etc. are display groups containing regional and Apple-specific
variants. `locale` and provenance retain original codes. `Base` grouped under
English is a UI compatibility choice, not confirmation of English. Filename-based
language supplements are inferred and should not be described as explicit codes.

Coverage is limited to collected components and supported formats. Missing hits
are not proof of incorrect translation or absence in Apple software. Preserve
structured plural forms; do not replace them with one selected branch.

Searches send terms and filters to the chosen server in a GET URL. They may occur
in server/proxy logs and shell history. Do not send confidential app text without
appropriate permission. The skill/helper is a prototype client, not a guarantee
of public-service quotas, availability, or cross-agent compatibility.
