import test from "node:test";
import assert from "node:assert/strict";
import {
  createSearchLoader,
  searchErrorLabel,
  searchErrorMessage,
} from "../frontend/js/search_loader.js";

const result = { data: [{ id: 1 }], total: 1, last_page: 1 };
test("compact status labels keep error kinds distinct", () => {
  for (
    const [kind, label] of Object.entries({
      timeout: "Timed out",
      connection: "Connection failed",
      "invalid-query": "Invalid search",
      "invalid-response": "Invalid response",
      server: "Server error",
    })
  ) assert.equal(searchErrorLabel({ kind }), label);
  assert.equal(
    searchErrorLabel({ kind: "server", status: 500 }),
    "Server error (500)",
  );
});
test("retry holds the exact failed page without automatic retries or skipped pages", async () => {
  const calls = [], statuses = [];
  let report;
  const failed = new Promise((resolve) => {
    report = resolve;
  });
  const loader = createSearchLoader({
    onStatus(s) {
      statuses.push(s);
      if (s.phase === "error") report(s);
    },
    async fetchImpl(url) {
      calls.push(url);
      return calls.length === 1
        ? new Response("Unavailable", { status: 503 })
        : Response.json(result);
    },
  });
  const pending = loader.request(
    "/api/macos/26/search?q=C%2B%2B&l=English&l=Japanese",
    { page: 2, size: 200 },
  );
  const error = await failed;
  assert.equal(error.error.kind, "server");
  assert.equal(calls.length, 1);
  error.retry();
  error.retry();
  assert.deepEqual(await pending, result);
  assert.equal(calls.length, 2);
  assert.equal(calls[0], calls[1]);
  assert.deepEqual(new URL(calls[1]).searchParams.getAll("l"), [
    "English",
    "Japanese",
  ]);
  assert.equal(new URL(calls[1]).searchParams.get("page"), "2");
  assert.deepEqual(statuses.map((s) => s.phase), [
    "loading",
    "error",
    "loading",
    "received",
  ]);
});

for (
  const [name, fetchImpl, kind] of [
    ["network", async () => {
      throw new TypeError("Failed to fetch");
    }, "connection"],
    [
      "database timeout",
      async () =>
        Response.json({ error: "検索がタイムアウトしました。" }, {
          status: 503,
        }),
      "timeout",
    ],
    [
      "gateway timeout",
      async () => new Response("gateway", { status: 504 }),
      "timeout",
    ],
    ["server", async () => new Response("internal", { status: 500 }), "server"],
    ["query", async () => Response.json({}, { status: 400 }), "invalid-query"],
    ["invalid JSON", async () => new Response("not json"), "invalid-response"],
    [
      "invalid shape",
      async () => Response.json({ data: [] }),
      "invalid-response",
    ],
    ["client timeout", (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => reject(new DOMException("timeout", "AbortError")),
        );
      }), "timeout"],
  ]
) {
  test(`${name}: classified and cancellable while awaiting retry`, async () => {
    let report;
    const failed = new Promise((resolve) => {
      report = resolve;
    });
    const loader = createSearchLoader({
      fetchImpl,
      timeoutMs: 15,
      onStatus(s) {
        if (s.phase === "error") report(s);
      },
    });
    const pending = loader.request("/api/search");
    const error = await failed;
    assert.equal(error.error.kind, kind);
    assert.ok(searchErrorMessage(error.error).length > 20);
    loader.cancel();
    error.retry();
    await assert.rejects(pending, { name: "AbortError" });
  });
}

test("cancellation aborts active fetch without displaying a failure", async () => {
  const statuses = [];
  const loader = createSearchLoader({
    onStatus(s) {
      statuses.push(s);
    },
    fetchImpl: (_url, { signal }) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () =>
          reject(new DOMException("abort", "AbortError")));
      }),
  });
  const pending = loader.request("/api/search");
  loader.cancel();
  await assert.rejects(pending, { name: "AbortError" });
  assert.deepEqual(statuses.map((s) => s.phase), ["loading"]);
});
