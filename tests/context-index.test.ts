import { strict as assert } from "node:assert";
import {
  buildSearch,
  type Catalog,
  contextIndexSchema,
  loadContextIndex,
} from "../backend/search/api.ts";
const schema = "localization_context_fixture",
  sidecar = "context_context_fixture";
const catalog: Catalog = {
  durableSchema: schema,
  manifest: "a".repeat(64),
  sourceId: "fixture",
  total: 3,
  languages: [{
    id: 1,
    code: "ja",
    raw: "Japanese",
    basis: "lproj",
    status: "explicit",
    rows: 3,
  }],
  bundles: [{ id: 1, path: "/A.app" }],
};
function fixture() {
  const tables = ["member", "metadata"].map((name) => ({
    name,
    persistence: "p",
  }));
  const rows = [{
    version: 1,
    source_schema: schema,
    manifest_sha256: catalog.manifest,
    source_id: "fixture",
    source_rows: "3",
    member_rows: "3",
    status: "verified",
  }];
  const indexes = [{
    name: "member_pkey",
    primary_key: true,
    keys: 1,
    first: "occurrence_id",
    second: "",
    third: "",
  }, {
    name: "member_context_language_idx",
    primary_key: false,
    keys: 3,
    first: "context_id",
    second: "language_id",
    third: "occurrence_id",
  }];
  const query = async (sql: string) => {
    if (sql.includes("to_regnamespace")) return [{ name: sidecar }];
    if (sql.includes("relpersistence")) return tables;
    if (sql.includes(".metadata")) return rows;
    if (sql.includes("pg_index")) return indexes;
    throw Error(sql);
  };
  return { query, tables, rows, indexes };
}
Deno.test("context index is optional, pinned, logged and ready; corrupt sidecars fail closed", async () => {
  assert.equal(contextIndexSchema(schema), sidecar);
  assert.throws(() => contextIndexSchema("public;DROP"));
  assert.equal(
    await loadContextIndex(async () => [{ name: null }], schema, catalog),
    undefined,
  );
  const f = fixture();
  assert.deepEqual(await loadContextIndex(f.query, schema, catalog), {
    version: 1,
    schema: sidecar,
    manifest: catalog.manifest,
  });
  for (
    const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.rows[0].manifest_sha256 = "b".repeat(64);
      },
      (f: ReturnType<typeof fixture>) => {
        f.rows[0].source_schema = "localization_other";
      },
      (f: ReturnType<typeof fixture>) => {
        f.rows[0].status = "building";
      },
      (f: ReturnType<typeof fixture>) => {
        f.rows[0].source_rows = "4";
      },
      (f: ReturnType<typeof fixture>) => {
        f.rows[0].member_rows = "NaN";
      },
      (f: ReturnType<typeof fixture>) => {
        f.rows.push(f.rows[0]);
      },
      (f: ReturnType<typeof fixture>) => {
        f.tables[0].persistence = "u";
      },
      (f: ReturnType<typeof fixture>) => {
        f.indexes.pop();
      },
      (f: ReturnType<typeof fixture>) => {
        f.indexes[0].primary_key = false;
      },
      (f: ReturnType<typeof fixture>) => {
        f.indexes[1].third = "other";
      },
    ]
  ) {
    const f = fixture();
    mutate(f);
    await assert.rejects(
      () => loadContextIndex(f.query, schema, catalog),
      /Invalid or unverified/,
    );
  }
});
Deno.test("context search keeps filters, ordering, details and advanced SQL; binding cannot come from URL", () => {
  const indexed = {
    ...catalog,
    contextIndex: {
      version: 1 as const,
      schema: sidecar,
      manifest: catalog.manifest,
    },
  };
  for (
    const q of [
      "q=設定",
      "q=Open&b=A.app&l=Japanese&page=2",
      "bundle_path=/A.app&locale=ja",
      "b=A.app",
      "q=x&l=absent",
    ]
  ) {
    const p = new URLSearchParams(q),
      before = buildSearch(schema, catalog, p, false),
      after = buildSearch(schema, indexed, p, false);
    assert.deepEqual(before.args, after.args);
    assert.equal(before.emptyScope, after.emptyScope);
    assert.match(before.sql, /candidate_resources/);
    assert.ok(!before.sql.includes(sidecar));
    assert.match(after.sql, /m.context_id=g.context_id/);
    assert.match(after.sql, /WHERE m.language_id = ANY/);
    assert.ok(!after.sql.includes("candidate_resources"));
    assert.equal(
      before.sql.slice(before.sql.indexOf("  page AS MATERIALIZED")),
      after.sql.slice(after.sql.indexOf("  page AS MATERIALIZED")),
    );
    if (q.includes("b=") || q.includes("bundle_path")) {
      assert.match(after.sql, /r.bundle_id = ANY/);
    }
  }
  const advanced = new URLSearchParams("q=Open&c=key&o=equal&l=Japanese");
  assert.deepEqual(
    buildSearch(schema, indexed, advanced, true),
    buildSearch(schema, catalog, advanced, true),
  );
  const plain = new URLSearchParams("q=設定");
  assert.deepEqual(
    buildSearch(schema, catalog, plain, false),
    buildSearch(
      schema,
      catalog,
      new URLSearchParams("q=設定&context_index=untrusted"),
      false,
    ),
  );
  assert.throws(() =>
    buildSearch(
      schema,
      {
        ...indexed,
        contextIndex: { ...indexed.contextIndex, schema: "context_other" },
      },
      plain,
      false,
    )
  );
});
