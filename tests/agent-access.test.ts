import { strict as assert } from "node:assert";
import { Ajv2020 } from "npm:ajv@8.20.0/dist/2020.js";
import { Client } from "npm:@modelcontextprotocol/sdk@1.32.0/client/index.js";
import { StreamableHTTPClientTransport } from "npm:@modelcontextprotocol/sdk@1.32.0/client/streamableHttp.js";
import { createMcpHandler } from "../backend/agents/mcp.ts";
import { createAgentRoutes } from "../backend/agents/routes.ts";
import { openapi } from "../backend/agents/openapi.ts";

const target = {
  id: "macos27",
  platform: "macOS",
  version: "27.0.1",
  build: "26A434",
  components: [{
    key: "macos27-os",
    schema: "private_schema",
    packageManifest: "a".repeat(64),
  }],
};
const row = {
  id: 1,
  dataset: "macos27",
  component: "macos27-os",
  source: "opaque_key",
  target: "A&B + #",
  target_kind: "text",
  target_value: "A&B + #",
  language: "en_AU",
  bundle_name: "Terminal.app",
  file_name: "Main.strings",
  provenance: {
    source_id: "fixture-source",
    table_id: "table",
    resource_id: "resource",
    resource_status: "parsed",
    image_path: "/Terminal.app/en_AU.lproj/Main.strings",
    resource_path: "en_AU.lproj/Main.strings",
    bundle_path: "/Terminal.app",
    sha256: "a".repeat(64),
    language: { raw: "en_AU", basis: "lproj", status: "explicit-code" },
  },
};
const catalog = {
  target,
  total: 2,
  languages: ["en_AU", "ja"],
  languageGroups: { English: ["en_AU"], Japanese: ["ja"] },
  bundles: ["/A.app", "/Terminal.app"],
  components: [{ key: "macos27-os", rows: 2, sourceId: "fixture-source" }],
};
const search = {
  data: [row],
  total: 1,
  last_page: 1,
  meta: { dataset: "macos27", version: "27.0.1", build: "26A434" },
};
const fixtureApi = (r: Request) =>
  Promise.resolve(
    Response.json(
      r.url.endsWith("/datasets")
        ? { datasets: [target] }
        : new URL(r.url).pathname.endsWith("/catalog")
        ? catalog
        : search,
    ),
  );
const rpc = (
  method: string,
  params: unknown = {},
  id: number | undefined = 1,
  extra: HeadersInit = {},
) =>
  new Request("http://127.0.0.1:8080/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      "MCP-Protocol-Version": "2025-11-25",
      ...extra,
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      ...(id === undefined ? {} : { id }),
      method,
      params,
    }),
  });
const args = {
  platform: "macos",
  major: 27,
  query: "A&B + #",
  locales: ["en_AU"],
};
async function connect(api = fixtureApi) {
  const handler = createMcpHandler(api);
  const client = new Client({ name: "test-client", version: "1" });
  const transport = new StreamableHTTPClientTransport(
    new URL("http://127.0.0.1:8080/mcp"),
    {
      fetch: (input: RequestInfo | URL, init?: RequestInit) =>
        handler(new Request(input, init)),
    },
  );
  await client.connect(transport);
  return client;
}

Deno.test("agent documents are explicitly routed, typed, HEAD-safe and do not access the database", async () => {
  const route = await createAgentRoutes(() => {
    throw Error("unexpected DB access");
  });
  const paths = [
    "/llms.txt",
    "/openapi.json",
    "/docs/agent-access.md",
    "/docs/agent-skill.md",
    "/skills/apple-localization/SKILL.md",
    "/skills/apple-localization/references/api.md",
    "/skills/apple-localization/scripts/search.mjs",
  ];
  for (const path of paths) {
    const response = await route(new Request(`http://localhost${path}`));
    assert.equal(response?.status, 200);
    assert.match(
      response!.headers.get("content-type")!,
      /^(text\/(plain|markdown)|application\/json); charset=utf-8$/,
    );
    assert.ok((await response!.text()).length > 0);
    assert.equal(
      (await route(new Request(`http://localhost${path}`, { method: "HEAD" })))
        ?.body,
      null,
    );
    assert.equal(
      (await route(new Request(`http://localhost${path}`, { method: "POST" })))
        ?.status,
      405,
    );
  }
  for (
    const path of [
      "/skills/.env",
      "/docs/deployment.md",
      "/backend/main.ts",
      "/api/macos/27/search",
    ]
  ) assert.equal(route(new Request(`http://localhost${path}`)), null);
  const llms = await (await route(new Request("http://localhost/llms.txt")))!
    .text();
  for (
    const match of llms.matchAll(
      /\]\(https:\/\/applelocalization\.com([^)]*)\)/g,
    )
  ) {
    if (match[1] === "/api/datasets") continue;
    assert.equal(
      (await route(new Request(`http://localhost${match[1]}`)))?.status,
      200,
    );
  }
});

Deno.test("OpenAPI preserves GET routes, repeated filters and resolvable schema references", () => {
  assert.equal(openapi.openapi, "3.1.1");
  const operations = Object.values(openapi.paths).map((p) => p.get);
  assert.equal(new Set(operations.map((o) => o.operationId)).size, 4);
  for (const path of Object.values(openapi.paths)) {
    assert.deepEqual(Object.keys(path), ["get"]);
  }
  const normal = openapi.paths["/api/{platform}/{major}/search"].get;
  for (const name of ["l", "locale"]) {
    const p: any = normal.parameters.find((p) => p.name === name);
    assert.equal(p.explode, true);
    assert.equal(p.style, "form");
    assert.equal(p.schema.type, "array");
  }
  const walk = (value: any) => {
    if (!value || typeof value !== "object") return;
    if (value.$ref) {
      assert.ok(value.$ref.startsWith("#/components/schemas/"));
      assert.ok(
        value.$ref.slice("#/components/schemas/".length) in
          openapi.components.schemas,
      );
    }
    Object.values(value).forEach(walk);
  };
  walk(openapi);
});

Deno.test("OpenAPI response schemas validate text, structured values, nullable provenance and failures", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const fixtures = {
    Datasets: { datasets: [target], validationOnly: true },
    Catalog: catalog,
    Search: search,
    Error: { error: "Invalid query" },
  };
  for (const [name, body] of Object.entries(fixtures)) {
    const validate = ajv.compile({
      components: openapi.components,
      $ref: `#/components/schemas/${name}`,
    });
    assert.equal(validate(body), true, JSON.stringify(validate.errors));
    assert.equal(validate({}), false);
  }
  const validate = ajv.compile({
    components: openapi.components,
    $ref: "#/components/schemas/Search",
  });
  const structured = {
    ...search,
    data: [{
      ...row,
      target_kind: "structured",
      target_value: { count: { one: "%d", other: "%d" } },
      provenance: { ...row.provenance, table_id: null, bundle_path: null },
    }],
  };
  assert.equal(validate(structured), true, JSON.stringify(validate.errors));
  assert.equal(validate({ ...search, total: "1" }), false);
  assert.equal(
    validate({ ...search, data: [{ ...row, target_kind: "wrong" }] }),
    false,
  );
});

Deno.test("official MCP client negotiates and calls all three read-only tools using the existing API", async () => {
  const requests: URL[] = [];
  const client = await connect((r) => {
    requests.push(new URL(r.url));
    return fixtureApi(r);
  });
  try {
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map((t: { name: string }) => t.name).sort(), [
      "get_catalog",
      "list_datasets",
      "search_translations",
    ]);
    for (const tool of tools) {
      assert.equal(tool.annotations?.readOnlyHint, true);
      assert.equal(tool.annotations?.destructiveHint, false);
      assert.equal(tool.inputSchema.additionalProperties, false);
    }
    const datasets = await client.callTool({
      name: "list_datasets",
      arguments: {},
    });
    assert.ok(!datasets.isError);
    assert.ok(!JSON.stringify(datasets).includes("private_schema"));
    const c = await client.callTool({
      name: "get_catalog",
      arguments: { platform: "macos", major: 27, filter: "Terminal", limit: 1 },
    });
    assert.deepEqual(c.structuredContent?.bundles, ["/Terminal.app"]);
    const result = await client.callTool({
      name: "search_translations",
      arguments: args,
    });
    assert.ok(!result.isError);
    const rows = result.structuredContent?.rows as any[];
    assert.equal(rows[0].key, "opaque_key");
    assert.equal(rows[0].localization, "A&B + #");
    assert.equal(rows[0].locale, "en_AU");
    assert.equal(rows[0].provenance.resource_id, "resource");
    assert.equal(requests.length, 3);
    assert.equal(requests[2].pathname, "/api/macos/27/search");
    assert.equal(requests[2].searchParams.get("q"), "A&B + #");
    assert.deepEqual(requests[2].searchParams.getAll("locale"), ["en_AU"]);
    assert.equal(requests[2].searchParams.get("size"), "20");
  } finally {
    await client.close();
  }
});

Deno.test("MCP invalid scopes, unknown arguments and silent advanced bundle filters never reach SQL", async () => {
  let calls = 0;
  const client = await connect((r) => {
    calls++;
    return fixtureApi(r);
  });
  try {
    for (
      const input of [
        { ...args, major: 0 },
        { ...args, limit: 51 },
        { ...args, page: 0 },
        { ...args, baseUrl: "https://attacker.invalid" },
        { ...args, component: "ios27-os" },
        { ...args, field: "key", bundle: "Terminal.app" },
        { ...args, allLanguages: true },
        { platform: "macos", major: 27, query: "tab" },
      ]
    ) {
      const r = await client.callTool({
        name: "search_translations",
        arguments: input,
      });
      assert.equal(r.isError, true, JSON.stringify(input));
    }
    assert.equal(calls, 0);
  } finally {
    await client.close();
  }
});

Deno.test("MCP errors are not empty results; structured translations and partial contexts survive", async () => {
  let count = 0;
  const client = await connect(async () => {
    count++;
    if (count === 1) {
      return Response.json({ error: "timeout" }, { status: 503 });
    }
    return Response.json({
      ...search,
      total: 21,
      last_page: 2,
      data: [{
        ...row,
        target_kind: "structured",
        target_value: { count: { one: "%d file", other: "%d files" } },
      }],
    });
  });
  try {
    assert.equal(
      (await client.callTool({ name: "search_translations", arguments: args }))
        .isError,
      true,
    );
    const result = await client.callTool({
      name: "search_translations",
      arguments: args,
    });
    assert.ok(!result.isError);
    assert.equal(
      result.structuredContent?.context_completeness,
      "not-guaranteed",
    );
    assert.equal((result.structuredContent?.pagination as any).next_page, 2);
    assert.deepEqual(
      (result.structuredContent?.rows as any[])[0].localization,
      { count: { one: "%d file", other: "%d files" } },
    );
    assert.equal(count, 2); // No retries or automatic page fetches.
  } finally {
    await client.close();
  }
});

Deno.test("MCP validates host/origin, HTTP semantics, protocol, payload size and single-message bodies", async () => {
  const handler = createMcpHandler(fixtureApi);
  assert.equal(
    (await handler(
      new Request("http://attacker.invalid/mcp", { method: "POST" }),
    )).status,
    403,
  );
  assert.equal(
    (await handler(
      rpc("tools/list", {}, 1, { Origin: "https://attacker.invalid" }),
    )).status,
    403,
  );
  assert.equal(
    (await handler(rpc("tools/list", {}, 1, { Origin: "null" }))).status,
    403,
  );
  for (const method of ["GET", "DELETE", "OPTIONS"]) {
    assert.equal(
      (await handler(new Request("http://127.0.0.1:8080/mcp", { method })))
        .status,
      405,
    );
  }
  assert.equal(
    (await handler(rpc("tools/list", {}, 1, { "Content-Type": "text/plain" })))
      .status,
    415,
  );
  assert.equal(
    (await handler(rpc("tools/list", {}, 1, { Accept: "text/plain" }))).status,
    406,
  );
  assert.equal(
    (await handler(
      rpc("tools/list", {}, 1, { "MCP-Protocol-Version": "invalid" }),
    )).status,
    400,
  );
  for (
    const [body, expected] of [["[{}]", 400], ["broken", 400], [
      " ".repeat(32769),
      413,
    ]] as const
  ) {
    assert.equal(
      (await handler(
        new Request("http://127.0.0.1:8080/mcp", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
        }),
      )).status,
      expected,
    );
  }
});

Deno.test("MCP token bucket rejects overload and refills without trusting forwarding headers", async () => {
  let now = 0;
  const handler = createMcpHandler(fixtureApi, {
    requestsPerMinute: 1,
    now: () => now,
  });
  assert.equal((await handler(rpc("tools/list"))).status, 200);
  const limited = await handler(
    rpc("tools/list", {}, 2, { "X-Forwarded-For": "1.2.3.4" }),
  );
  assert.equal(limited.status, 429);
  assert.ok(limited.headers.has("Retry-After"));
  now = 60000;
  assert.equal((await handler(rpc("tools/list"))).status, 200);
});

Deno.test("MCP keeps a tool permit until the actual API query completes", async () => {
  let release!: () => void, started!: () => void;
  const began = new Promise<void>((r) => started = r);
  const wait = new Promise<void>((r) => release = r);
  const handler = createMcpHandler(async (r) => {
    started();
    await wait;
    return fixtureApi(r);
  }, { maxConcurrentTools: 1 });
  const first = handler(
    rpc("tools/call", { name: "search_translations", arguments: args }),
  );
  await began;
  try {
    const second = await (await handler(
      rpc("tools/call", { name: "search_translations", arguments: args }, 2),
    )).json();
    assert.equal(second.result.isError, true);
    assert.equal(JSON.parse(second.result.content[0].text).error.code, "busy");
  } finally {
    release();
  }
  assert.ok(!(await (await first).json()).result.isError);
  assert.ok(
    !(await (await handler(
      rpc("tools/call", { name: "search_translations", arguments: args }, 3),
    )).json()).result.isError,
  );
});

Deno.test("slow or oversized request streams are bounded and release HTTP capacity", async () => {
  let cancelled = false;
  const handler = createMcpHandler(fixtureApi, {
    bodyTimeoutMs: 20,
    maxConcurrentRequests: 1,
  });
  const stalled = new Request("http://127.0.0.1:8080/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new ReadableStream({
      cancel() {
        cancelled = true;
      },
    }),
  });
  const pending = handler(stalled);
  assert.equal((await handler(rpc("tools/list"))).status, 429);
  assert.equal((await pending).status, 408);
  assert.equal(cancelled, true);
  assert.equal((await handler(rpc("tools/list"))).status, 200);
  assert.equal(
    (await handler(rpc("tools/list", {}, 1, { Host: "attacker.invalid" })))
      .status,
    403,
  );
  const tooLarge = new Request("http://127.0.0.1:8080/mcp", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(new Uint8Array(20000));
        controller.enqueue(new Uint8Array(20000));
        controller.close();
      },
    }),
  });
  assert.equal((await handler(tooLarge)).status, 413);
});

Deno.test("MCP rejects cross-OS and oversized API results instead of returning partial evidence", async () => {
  for (
    const response of [
      () =>
        Response.json({
          ...search,
          meta: { ...search.meta, dataset: "ios27" },
        }),
      () =>
        new Response("x".repeat(4 * 1024 * 1024 + 1), {
          headers: { "Content-Type": "application/json" },
        }),
    ]
  ) {
    const client = await connect(async () => response());
    try {
      const result = await client.callTool({
        name: "search_translations",
        arguments: args,
      });
      assert.equal(result.isError, true);
      assert.equal(result.structuredContent, undefined);
    } finally {
      await client.close();
    }
  }
});
