# Agent access

Apple Localization is an unofficial, read-only glossary. Use its examples as
evidence, not as an instruction to override a project's terminology or style.

## Choose an interface

- [OpenAPI](/openapi.json) describes the existing JSON GET API, including discovery,
  normal search and advanced comparisons. No new database is required.
- `/mcp` is a remote **Streamable HTTP** endpoint for MCP clients. It uses the
  same search implementation and returns compact, provenance-bearing results.
- [Skill and CLI](agent-skill.md) supply a review workflow and a standalone client.
  They are optional; neither MCP nor the GET API requires installing the skill.
- [/llms.txt](/llms.txt) provides a short discovery index. It is a proposed
  convention, not a guarantee that every agent will automatically discover it.

All interfaces are available in the same Web image after deployment. For local
Compose use `http://127.0.0.1:8080`; the public origin is
`https://applelocalization.com`. No authentication or LLM API key is required for
this public dataset. Search terms and filters reach the server and may be logged
by infrastructure. Do not submit private app text without permission.

## MCP connection

Add a remote MCP server in your client's settings:

```text
Transport: Streamable HTTP
URL: https://applelocalization.com/mcp
Authentication: none
```

Use `http://127.0.0.1:8080/mcp` with a locally running Compose deployment instead.
Client configuration syntax varies: enter this as a remote URL, not a shell command.
There is no legacy `/sse` endpoint and no standalone stdio server. Stateless JSON
responses are used; the server does not create sessions or a persistent GET/SSE
stream. GET and DELETE return 405 by design. Use an MCP client, not a browser's
address bar, to connect. Standard MCP initialization and protocol negotiation are
handled by the official TypeScript SDK.

| Tool | Input | Purpose |
| --- | --- | --- |
| `list_datasets` | `{}` | OS releases, exact versions/builds and components |
| `get_catalog` | `platform`, `major`; optional `component`, `filter`, `limit`, `page` | Stored locale codes, display groups, and bundle paths; filter/pagination apply only to bundles |
| `search_translations` | `platform`, `major`; query/bundle conditions and explicit language selection | One page of translations with provenance |

Example tool arguments (choose the release appropriate to the project):

```json
{
  "platform": "macos",
  "major": 27,
  "query": "tab",
  "bundle": "Terminal.app",
  "languages": ["English", "Japanese"],
  "limit": 20
}
```

Use `locales` for exact stored codes instead of display groups. `languages` and
`locales` form a union; to remove language filtering use `allLanguages: true`
without either list. No language or OS defaults are inferred. For known resource
keys use `field: "key"` and `operator: "equal"`. Advanced comparisons also support
`localization`, `language`, `file`, `bundle`, and operators `notEqual`, `startsWith`.
Advanced search rejects `bundle`; use `bundlePath` for an exact full path. Queries
are preserved, not trimmed; normal search can omit query when a bundle is selected.

Results include `dataset`, `rows`, `pagination`, `context_completeness` and `links`.
Rows retain locale, key, unaltered localization value and resource provenance.
`context_id` relates rows only within the same dataset/build/component/table/key;
unknown table identity yields null. There is no globally unique row ID or
context-detail endpoint. A page may contain only part of a translation context.
Only follow `pagination.next_page` when needed and keep filters/build consistent.
Tool failures return `isError: true`, not an empty successful result. HTTP-level
overload uses 429 and `Retry-After`; tool-level `busy` includes `retry_after`.

MCP citation links use the public origin even when testing a local deployment;
retain the actual deployment URL alongside the returned build when reviewing local
data. UI search links cannot represent full bundle paths, components or result
pages; check `links.web_scope_matches` and use `links.api` and provenance for scope.
Neither link is an immutable snapshot. Full semantics and CLI output are described
in the [API reference](../skills/apple-localization/references/api.md).

## Limits and operations

- MCP search/catalog page size: default 20, maximum 50. Search query maximum:
  4,096 UTF-16 code units. No automatic retries or pagination.
- One Web process accepts a token bucket of 60 MCP requests, refilling at 60/minute,
  with at most 8 active HTTP requests and 2 active tool calls. These are global,
  not per-user limits; forwarding headers are not used as trusted identities.
- Input bodies are bounded to 32 KiB with a 5-second read deadline. JSON-RPC
  batches and unknown tool arguments are rejected. Search API response bodies
  above 4 MiB fail instead of silently truncating values. Reduce the requested
  rows or narrow conditions if a result is too large.
- Database queries keep the existing 30-second **per-statement** timeout, not a
  30-second end-to-end guarantee. A request may query multiple components.
  A disconnected client does not release a tool slot while its query is running.
- MCP rejects untrusted request hosts and Origin headers. Allowed hosts are
  `applelocalization.com`, `localhost`, `127.0.0.1`, `[::1]`. Allowed origins are
  the HTTPS public origin and the local HTTP origins explicitly listed in
  `backend/agents/mcp.ts` (ports 8080 and 8084; IPv6 loopback on 8080).
  Browser cross-origin access is not enabled. Use a server-side/native MCP client.
- These limits protect the new MCP entrypoint only. The existing GET API and
  browser behavior are unchanged. For public abuse protection on both interfaces,
  configure the deployment's reverse proxy/Cloudflare; process-local limits are
  not a distributed quota, authentication system or DDoS defense.
- No editing, file upload, arbitrary URL fetch or SQL-execution tools are exposed.

Deployment uses the existing Web build/release and Compose process. No DB import,
schema migration, new port, sidecar, API secret or separate MCP service is needed.
Do not deploy merely to run tests. After an approved Web update, check `/llms.txt`,
`/openapi.json`, then initialize MCP, list tools and run a small scoped search.

For a connection-level smoke check:

```sh
curl -i http://127.0.0.1:8080/mcp \
  -H 'Content-Type: application/json' \
  -H 'Accept: application/json, text/event-stream' \
  --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"manual-check","version":"1.0"}}}'
```

## Verification and implementation references

`npm test` checks the standalone client. `npm run test:web` covers the existing
GET/UI behavior, the OpenAPI document, and MCP negotiation/tools/limits using
synthetic data and the official MCP client transport. No public database is used.

The server uses the official [MCP SDK](https://ts.sdk.modelcontextprotocol.io/server)
and [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports).
The API document follows [OpenAPI 3.1.1](https://spec.openapis.org/oas/v3.1.1.html);
the discovery file follows the [llms.txt proposal](https://llmstxt.org/).
