import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { batch } from "../scripts/candidate-pipeline.mjs";
import { releaseCatalog } from "../scripts/compose-release-set.mjs";
import {
  createReleaseReview,
  parseReleaseMetadata,
  resolveReviewRoute,
} from "../backend/search/release-set.ts";
import type { Snapshot } from "../backend/search/api.ts";
const hash = (s: string | Uint8Array) =>
  createHash("sha256").update(s).digest("hex");
function fixture() {
  const bundles = batch.targets.map((t: any) => ({
    formatVersion: 1,
    status: "candidate-sql-bundle-verified",
    target: t,
    apiCompatible: false,
    productionReady: false,
    published: false,
    components: batch.jobs.filter((j: any) => j.target === t.id).map((
      j: any,
    ) => ({
      ...j,
      packageManifest: "a".repeat(64),
      sqlSha256: "b".repeat(64),
      sqlReportSha256: "c".repeat(64),
      sourceId: `${t.platform}-${t.version}-${t.build}-${j.key}`,
      rows: 2,
    })),
  }));
  const raw = Object.fromEntries(
    bundles.map((
      b: any,
    ) => [b.target.id, new TextEncoder().encode(JSON.stringify(b))]),
  );
  const catalog = {
    ...releaseCatalog(bundles),
    inputs: bundles.map((b: any) => ({
      target: b.target.id,
      bundleSha256: hash(raw[b.target.id]),
    })),
  };
  const bytes = new TextEncoder().encode(JSON.stringify(catalog));
  const queries: string[] = [];
  const limits: number[] = [];
  const components = bundles.flatMap((b: any) => b.components);
  const snapshot: Snapshot = async (work) =>
    await work(async (sql, args = []) => {
      if (sql.startsWith("SET ")) return [];
      if (sql.includes("c.relpersistence")) {
        return [
          "bundle",
          "issue",
          "language",
          "occurrence",
          "package",
          "quarantine",
          "resource",
          "resource_table",
          "source",
          "symlink",
        ].map((name) => ({ name, persistence: "p" }));
      }
      if (sql.includes("pg_get_indexdef")) {
        return [
          { name: "target_index", column_name: "target_text" },
          { name: "json_index", column_name: "target_json" },
        ];
      }
      const c = components.find((c: any) => sql.includes(c.schema));
      assert.ok(c);
      if (sql.includes(".package")) {
        return [{
          manifest_sha256: c.packageManifest,
          catalog_json: JSON.stringify({ sourceId: c.sourceId }),
          report_json: JSON.stringify({
            formatVersion: 1,
            outputKind: "localization-occurrence-package",
            status: "prepared-not-imported",
            sourceId: c.sourceId,
          }),
        }];
      }
      if (sql.includes(".language ORDER")) {
        return [{
          id: 1,
          code: "ja",
          raw: "Japanese",
          basis: "lproj",
          status: "identified",
          rows: "2",
        }];
      }
      if (sql.includes(".bundle ORDER")) return [{ id: 1, path: "/A.app" }];
      queries.push(c.key);
      const offset = Number(args.at(-1)), size = Number(args.at(-2));
      limits.push(size);
      const rows = [1, 2].slice(offset, offset + size).map((id) => ({
        id,
        table_identity: "table",
        key_text: "Open",
        target_text: "開く",
        target_kind: "text",
        language: "ja",
        bundle_path: "/A.app",
        metadata_json: JSON.stringify({
          sourceId: c.sourceId,
          original: {
            imagePath: "/A.app/ja.lproj/Main.strings",
            resourcePath: "ja.lproj/Main.strings",
            bundleName: "A.app",
          },
        }),
      }));
      return [{ total: "2", rows_json: JSON.stringify(rows) }];
    });
  return { bytes, raw, catalog, queries, limits, snapshot };
}
Deno.test("current API preserves legacy GET shapes, strict settings and errors", async () => {
  const f = fixture(), settings: string[] = [];
  const metadata = parseReleaseMetadata(f.bytes, hash(f.bytes), f.raw);
  const snapshot: Snapshot = (work) =>
    f.snapshot((query) =>
      work(async (sql, args) => {
        if (sql.startsWith("SET ")) settings.push(sql);
        return query(sql, args);
      })
    );
  const app = await createReleaseReview(metadata, snapshot);
  for (
    const prefix of ["/api/macos", "/api/macos/26", "/api/ios", "/api/ios/26"]
  ) {
    for (
      const suffix of [
        "search?q=開く&l=Japanese",
        "search/advanced?c=key&o=equal&q=Open&l=Japanese",
      ]
    ) {
      const r = await app(
        new Request("http://localhost" + prefix + "/" + suffix),
      );
      assert.equal(r.status, 200);
      const body = await r.json();
      assert.ok(body.data.length);
      for (
        const field of [
          "id",
          "group_id",
          "source",
          "target",
          "language",
          "file_name",
          "bundle_name",
        ]
      ) assert.ok(field in body.data[0]);
    }
  }
  assert.ok(
    settings.includes("SET LOCAL pgroonga.match_escalation_threshold=-1"),
  );
  assert.ok(settings.includes("SET LOCAL pgroonga.force_match_escalation=off"));
  for (
    const path of [
      "/api/macos/search?q=x&page=bad",
      "/api/macos/search/advanced?c=key&o=bad&q=x",
    ]
  ) {
    assert.equal(
      (await app(new Request("http://localhost" + path))).status,
      400,
    );
  }
  assert.equal(
    (await app(new Request("http://localhost/api/macos/99/search?q=x"))).status,
    404,
  );
});
Deno.test("review metadata binds all twelve releases and refuses changed bundle bytes", () => {
  const f = fixture();
  assert.equal(
    parseReleaseMetadata(f.bytes, hash(f.bytes), f.raw).bundles.length,
    12,
  );
  assert.throws(() => parseReleaseMetadata(f.bytes, "0".repeat(64), f.raw));
  f.raw.ios27 = new TextEncoder().encode("{}");
  assert.throws(() => parseReleaseMetadata(f.bytes, hash(f.bytes), f.raw));
});
Deno.test("release search prunes absent scopes but validates them, and counts later components without fetching rows", async () => {
  const f = fixture();
  const app = await createReleaseReview(
    parseReleaseMetadata(f.bytes, hash(f.bytes), f.raw),
    f.snapshot,
  );
  const request = (suffix: string) =>
    app(new Request("http://localhost/api/ios/27/" + suffix));
  for (
    const params of [
      "q=x&l=absent",
      "q=x&locale=absent",
      "q=x&b=Missing.app",
      "q=x&bundle_path=/missing",
    ]
  ) {
    const response = await request("search?" + params);
    assert.equal(response.status, 200);
    const result = await response.json();
    assert.equal(result.total, 0);
    assert.deepEqual(result.data, []);
    assert.equal(result.last_page, 0);
    assert.deepEqual(Object.values(result.meta.components), [0, 0, 0]);
  }
  assert.equal(f.queries.length, 0);
  assert.equal((await request("search?l=absent")).status, 400);
  assert.equal(
    (await request("search/advanced?q=x&l=absent&c=key&o=invalid")).status,
    400,
  );
  const result = await (await request("search?q=Open&l=Japanese&size=1"))
    .json();
  assert.equal(result.total, 6);
  assert.equal(result.last_page, 6);
  assert.equal(result.data.length, 1);
  assert.deepEqual(f.limits, [1, 0, 0]);
  const advanced =
    await (await request("search/advanced?q=Open&c=key&o=equal&b=Missing.app"))
      .json();
  assert.equal(advanced.total, 6); // Legacy b is ignored for advanced search.
});
Deno.test("review routes select exactly one OS/major including latest aliases", () => {
  const f = fixture();
  assert.equal(
    resolveReviewRoute("/api/ios/search", f.catalog.datasets)?.target.id,
    "ios27",
  );
  assert.equal(
    resolveReviewRoute("/api/macos/26/search/advanced", f.catalog.datasets)
      ?.target.id,
    "macos26",
  );
  for (
    const route of [
      "/api/all/search",
      "/api/ios/99/search",
      "/api/ios/026/search",
      "/api/ios/27x/search",
    ]
  ) assert.equal(resolveReviewRoute(route, f.catalog.datasets), null);
});
Deno.test("unified review pagination crosses components without loss and retains variants/context", async () => {
  const f = fixture();
  const production = await createReleaseReview(
    parseReleaseMetadata(f.bytes, hash(f.bytes), f.raw),
    f.snapshot,
    { validationOnly: false },
  );
  for (
    const path of [
      "/api/datasets",
      "/api/ios/27/catalog",
      "/api/ios/27/search?q=Open&l=Japanese",
    ]
  ) {
    const result =
      await (await production(new Request("http://localhost" + path))).json();
    assert.equal(result.meta?.validationOnly ?? result.validationOnly, false);
  }
  f.queries.length = 0;
  const app = await createReleaseReview(
    parseReleaseMetadata(f.bytes, hash(f.bytes), f.raw),
    f.snapshot,
  );
  const request = (path: string) => app(new Request("http://localhost" + path));
  const result =
    await (await request("/api/ios/27/search?q=Open&l=Japanese&page=2&size=3"))
      .json();
  assert.equal(result.total, 6);
  assert.equal(result.last_page, 2);
  assert.deepEqual(result.data.map((r: any) => [r.component, r.id]), [
    ["ios27-appos", 2],
    ["ios27-systemos", 1],
    ["ios27-systemos", 2],
  ]);
  assert.ok(f.queries.every((c) => c.startsWith("ios27-")));
  assert.equal(result.meta.dataset, "ios27");
  assert.equal(result.data[0].source, "Open");
  assert.equal(result.data[0].target, "開く");
  assert.equal(result.data[0].provenance.bundle_path, "/A.app");
  assert.equal(
    (await request("/api/ios/27/search?q=x&component=macos27-os")).status,
    400,
  );
  assert.equal((await request("/api/ios/27/search")).status, 400);
  assert.equal((await request("/api/ios/27/search?page=-1&q=x")).status, 400);
  const end = await (await request("/api/ios/27/search?q=x&page=99")).json();
  assert.equal(end.data.length, 0);
  assert.equal(end.total, 6);
  const before = f.queries.length;
  const catalog = await (await request("/api/ios/27/catalog")).json();
  assert.equal(catalog.total, 6);
  assert.equal(f.queries.length, before);
});
