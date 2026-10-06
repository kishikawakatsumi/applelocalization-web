import { strict as assert } from "node:assert";
import {
  buildSearch,
  type Catalog,
  loadCatalog,
  loadStrictSearchPolicy,
  presentRow,
  validateSchema,
} from "../../backend/search/api.ts";

const catalog: Catalog = {
  manifest: "manifest",
  sourceId: "source",
  total: 4,
  languages: [
    {
      id: 1,
      code: "ja",
      raw: "ja",
      basis: "lproj-directory",
      status: "explicit-code",
      rows: 2,
    },
    {
      id: 2,
      code: "en",
      raw: "en",
      basis: "lproj-directory",
      status: "explicit-code",
      rows: 1,
    },
    {
      id: 3,
      code: "ja-JP",
      raw: "ja-JP",
      basis: "filename-convention",
      status: "inferred",
      rows: 1,
    },
  ],
  bundles: [{ id: 1, path: "/A.app" }, { id: 2, path: "/nested/A.app" }, {
    id: 3,
    path: null,
  }],
};
const row = {
  id: 1,
  table_identity: "table-a",
  key_text: "Open",
  key_json: null,
  target_text: "開く",
  target_json: null,
  target_kind: "text",
  language: "ja",
  resource_id: "resource-a",
  resource_status: "parsed",
  bundle_path: "/A.app",
  language_raw: "ja",
  language_basis: "lproj-directory",
  language_status: "explicit-code",
  metadata_json: JSON.stringify({
    sourceId: "source",
    original: {
      imagePath: "/A.app/ja.lproj/Main.strings",
      resourcePath: "ja.lproj/Main.strings",
      bundleName: "A.app",
      sha256: "sha",
    },
  }),
};

Deno.test("exact locale filters never expand a same-named group and unknown codes fail closed", () => {
  const c = {
    ...catalog,
    languageGroups: { English: ["en", "English"], Japanese: ["ja"] },
    languages: [...catalog.languages, {
      ...catalog.languages[1],
      id: 4,
      code: "English",
      raw: "English",
    }],
  };
  for (const advanced of [false, true]) {
    for (
      const [query, expected] of [
        ["l=English", [2, 4]],
        ["locale=English", [4]],
        ["locale=en", [2]],
        ["l=Japanese&locale=English", [1, 4]],
        ["locale=missing", []],
        ["locale=", []],
      ] as const
    ) {
      const p = new URLSearchParams(query + "&q=Open&c=key&o=equal");
      assert.deepEqual(
        buildSearch("ipsw_trial_test", c, p, advanced).args[0],
        expected,
      );
    }
  }
});

Deno.test("strict FTS is opt-in, parameterized and confined to a read-only request snapshot", async () => {
  const policy = await loadStrictSearchPolicy(async (_sql, args) => {
    assert.deepEqual(args, ["ipsw_trial_test"]);
    return [
      { name: "occurrence_target_text_idx1", column_name: "target_text" },
      { name: "occurrence_target_json_fts_idx", column_name: "target_json" },
    ];
  }, "ipsw_trial_test");
  const strict = { ...catalog, searchPolicy: policy };
  const built = buildSearch(
    "ipsw_trial_test",
    strict,
    new URLSearchParams({ q: "Settings" }),
    false,
  );
  assert.match(built.sql, /pgroonga_condition\(\$2, index_name => \$3\)/);
  assert.deepEqual(built.args.slice(1, 3), [
    "Settings",
    "occurrence_target_text_idx1",
  ]);
  assert.match(
    built.sql,
    /OR o.target_json &@ pgroonga_condition\(\$2, index_name => \$4\)/,
  );
  assert.equal(built.args[3], "occurrence_target_json_fts_idx");
  await assert.rejects(
    loadStrictSearchPolicy(async () => [
      { name: "target_idx", column_name: "target_text" },
    ], "ipsw_trial_test"),
    /migration/,
  );
  await assert.rejects(
    loadStrictSearchPolicy(async () => [
      { name: "target_idx", column_name: "target_text" },
      { name: "json_idx", column_name: "target_json" },
      { name: "json_idx2", column_name: "target_json" },
    ], "ipsw_trial_test"),
    /migration/,
  );
  assert.ok(
    !buildSearch(
      "ipsw_trial_test",
      catalog,
      new URLSearchParams({ q: "Settings" }),
      false,
    ).sql.includes("pgroonga_condition"),
  );
  await assert.rejects(
    loadStrictSearchPolicy(async () => [], "ipsw_trial_test"),
  );
  await assert.rejects(
    loadStrictSearchPolicy(async () => [{ name: "x;DROP" }], "ipsw_trial_test"),
  );
});

Deno.test("source catalog validates package version without counting occurrences; v1 response stays unchanged", async () => {
  const report = {
    status: "prepared-not-imported",
    outputKind: "localization-occurrence-package",
    formatVersion: 1,
    sourceId: "source",
  };
  const queries: string[] = [];
  const query = (sql: string) => {
    queries.push(sql);
    return Promise.resolve(
      sql.includes(".package")
        ? [{
          manifest_sha256: "manifest",
          report_json: JSON.stringify(report),
          catalog_json: JSON.stringify({ sourceId: "source" }),
        }]
        : [],
    );
  };
  const loaded = await loadCatalog(query, "ipsw_trial_test");
  assert.ok(!Object.hasOwn(loaded, "formatVersion"));
  assert.ok(queries.every((sql) => !/count\s*\(/i.test(sql)));
  report.formatVersion = 3;
  await assert.rejects(loadCatalog(query, "ipsw_trial_test"));
});

Deno.test("durable source access is explicitly pinned, logged and bound to one schema", async () => {
  const schema = "localization_fixture", manifest = "a".repeat(64);
  let persistence = "p";
  const names = [
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
  ];
  const query = async (sql: string) =>
    sql.includes("FROM pg_class")
      ? names.map((name) => ({ name, persistence }))
      : sql.includes(".package")
      ? [{
        manifest_sha256: manifest,
        report_json: JSON.stringify({
          status: "prepared-not-imported",
          outputKind: "localization-occurrence-package",
          formatVersion: 1,
          sourceId: "source",
        }),
        catalog_json: JSON.stringify({ sourceId: "source" }),
      }]
      : [];
  await assert.rejects(loadCatalog(query, schema));
  assert.throws(() => validateSchema(schema));
  await assert.rejects(
    loadCatalog(query, "public", { durableManifest: manifest }),
  );
  await assert.rejects(
    loadCatalog(query, schema, { durableManifest: "b".repeat(64) }),
  );
  const loaded = await loadCatalog(query, schema, {
    durableManifest: manifest,
  });
  assert.equal(loaded.durableSchema, schema);
  persistence = "u";
  await assert.rejects(
    loadCatalog(query, schema, { durableManifest: manifest }),
  );
  const pinned = { ...catalog, durableSchema: schema };
  assert.doesNotThrow(() =>
    buildSearch(schema, pinned, new URLSearchParams({ q: "Open" }), false)
  );
  assert.throws(() =>
    buildSearch("localization_other", pinned, new URLSearchParams(), false)
  );
});

Deno.test("v2 presentation is explicit and refuses incomplete ownership metadata", () => {
  const original = {
    ...JSON.parse(row.metadata_json).original,
    resourceId: row.resource_id,
    sourceId: "source",
    bundlePath: row.bundle_path,
  };
  const metadata = {
    resourceId: row.resource_id,
    sourceId: "source",
    original,
    effective: original,
    ownershipCorrection: null,
  };
  const changed = { ...row, metadata_json: JSON.stringify(metadata) };
  const result = presentRow(changed, 2);
  assert.deepEqual(result.provenance.original, original);
  assert.equal(result.provenance.ownership_correction, null);
  assert.equal(result.bundle_name, "A.app");
  assert.throws(() => presentRow(changed));
  assert.throws(() => presentRow(row, 2));
  assert.throws(() => presentRow({ ...changed, bundle_path: "/Wrong.app" }, 2));
  assert.throws(() =>
    presentRow({
      ...changed,
      metadata_json: JSON.stringify({
        ...metadata,
        effective: { ...original, bundleName: "Wrong.app" },
      }),
    }, 2)
  );
  const params = new URLSearchParams({ q: "A.app", c: "bundle", o: "equal" });
  assert.match(
    buildSearch(
      "ipsw_trial_test",
      { ...catalog, formatVersion: 2 },
      params,
      true,
    ).sql,
    /'effective'->>'bundleName'/,
  );
  assert.match(
    buildSearch("ipsw_trial_test", catalog, params, true).sql,
    /'original'->>'bundleName'/,
  );
});

Deno.test("trial schema guard and parameterized search filters", () => {
  assert.throws(() => validateSchema("public"));
  assert.throws(() => validateSchema("ipsw_trial_x; DROP SCHEMA public"));
  const input = new URLSearchParams({
    q: "' OR TRUE --",
    b: "A.app",
    page: "2",
    size: "300",
  });
  input.append("l", "Japanese");
  input.append("l", "English");
  const query = buildSearch("ipsw_trial_test", catalog, input, false);
  assert.deepEqual(query.args, [[1, 2], [1, 2], "' OR TRUE --", 200, 200]);
  assert.ok(!query.sql.includes("' OR TRUE --"));
  assert.match(query.sql, /matched AS MATERIALIZED/);
  assert.match(query.sql, /search_hits AS MATERIALIZED/);
  assert.match(query.sql, /FROM search_hits o JOIN/);
  assert.match(query.sql, /r.table_id IN \(SELECT table_id FROM matched\)/);
  assert.match(query.sql, /candidates AS MATERIALIZED/);
  assert.match(query.sql, /candidate_resources AS MATERIALIZED/);
  assert.match(query.sql, /COALESCE\(sum\(expected_rows\), 0\) <= 20000/);
  assert.match(query.sql, /WHERE o.resource_id = r.id OFFSET 0/);
  assert.match(query.sql, /UNION ALL/);
  assert.match(query.sql, /AND NOT \(SELECT narrow FROM lookup_strategy\)/);
  assert.match(query.sql, /g.table_id = o.table_id/);
  assert.match(query.sql, /\(g.key_text IS NULL\) = \(o.key_text IS NULL\)/);
  assert.match(query.sql, /FROM page p JOIN/);
  assert.deepEqual(
    buildSearch(
      "ipsw_trial_test",
      catalog,
      new URLSearchParams("q=x&l=unknown"),
      false,
    ).args[0],
    [],
  );
  assert.deepEqual(
    buildSearch(
      "ipsw_trial_test",
      catalog,
      new URLSearchParams("q=x&l=ja-JP"),
      false,
    ).args[0],
    [3],
  );
  assert.deepEqual(
    buildSearch(
      "ipsw_trial_test",
      catalog,
      new URLSearchParams("bundle_path=/nested/A.app"),
      false,
    ).args[1],
    [2],
  );
});

Deno.test("empty scopes validate requests first and count-only avoids page retrieval", () => {
  const build = (params: string, advanced = false, countOnly = false) =>
    buildSearch(
      "ipsw_trial_test",
      catalog,
      new URLSearchParams(params),
      advanced,
      undefined,
      { countOnly },
    );
  assert.equal(build("q=x&l=missing").emptyScope, true);
  assert.equal(build("q=x&b=Missing.app").emptyScope, true);
  assert.equal(build("q=x&bundle_path=/missing").emptyScope, true);
  assert.equal(build("q=x").emptyScope, false);
  assert.equal(build("q=x&b=A.app").emptyScope, false);
  assert.equal(
    build("q=x&c=key&o=equal&b=Missing.app", true).emptyScope,
    false,
  );
  assert.throws(() => build("l=missing"));
  assert.throws(() => build("q=x&l=missing&c=key&o=bad", true));
  assert.throws(() => build("q=x&l=missing&c=bad&o=equal", true));
  const page = build("q=x&page=2&size=3");
  const count = build("q=x&page=2&size=3", false, true);
  assert.equal(count.sql, page.sql);
  assert.deepEqual(count.args.slice(0, -2), page.args.slice(0, -2));
  assert.deepEqual(count.args.slice(-2), [0, 3]);
  assert.equal(count.size, 3);
  assert.ok(!page.sql.includes("search_hits AS MATERIALIZED"));
});

Deno.test("advanced SQL keeps indexed equality, literal prefixes and fallback equality", () => {
  const query = (q: string, o = "equal", c = "key") =>
    buildSearch(
      "ipsw_trial_test",
      catalog,
      new URLSearchParams({ q, o, c }),
      true,
    );
  assert.match(query("Open").sql, /o.key_text = \$2/);
  assert.ok(!query("Open").sql.includes("key_json ="));
  assert.equal(query("a%_\\", "startsWith").args[1], "a\\%\\_\\\\%");
  assert.equal(query("key\0nul").args[1], '"key\\u0000nul"');
  assert.match(query("Open", "notEqual").sql, /OR o.key_text IS NULL/);
  assert.match(
    query("開く", "equal", "localization").sql,
    /target_kind = 'text'/,
  );
  assert.throws(() => query("nul\0", "startsWith"));
  assert.throws(() => query("Open", "equal", "key;drop"));
});

Deno.test("presentation preserves variants, context, empty and structured values", () => {
  const a = presentRow(row);
  assert.equal(a.target, "開く");
  assert.equal(a.file_name, "Main.strings");
  assert.equal(a.provenance.image_path, "/A.app/ja.lproj/Main.strings");
  assert.equal(a.provenance.language.status, "explicit-code");
  assert.notEqual(
    a.group_id,
    presentRow({ ...row, table_identity: "table-b" }).group_id,
  );
  assert.equal(
    a.group_id,
    presentRow({ ...row, target_text: "始値" }).group_id,
  );
  assert.equal(presentRow({ ...row, target_text: "" }).target, "");
  assert.equal(
    presentRow({
      ...row,
      key_text: null,
      key_json: '"key\\u0000nul"',
      target_text: null,
      target_json: '"\\ud800"',
    }).target,
    "\ud800",
  );
  const structured = presentRow({
    ...row,
    target_kind: "structured",
    target_text: null,
    target_json: '{"one":"一つ","nul":"\\u0000"}',
  });
  assert.deepEqual(structured.target_value, { one: "一つ", nul: "\0" });
});

Deno.test("bundle evidence is passed through without inventing certainty for old packages", () => {
  const old = presentRow(row);
  assert.equal(old.provenance.bundle_assignment, null);
  assert.equal(old.provenance.bundle_evidence, null);
  const evidence = {
    version: 3,
    method: "unresolved-metadata",
    problems: [{ message: "Missing identifier" }],
  };
  const metadata = JSON.parse(row.metadata_json);
  metadata.original.bundleAssignment = "nearest-bundle-boundary-unresolved";
  metadata.original.bundleEvidence = evidence;
  const updated = presentRow({
    ...row,
    metadata_json: JSON.stringify(metadata),
  });
  assert.equal(
    updated.provenance.bundle_assignment,
    "nearest-bundle-boundary-unresolved",
  );
  assert.deepEqual(updated.provenance.bundle_evidence, evidence);
  assert.equal(updated.target, old.target);
  assert.equal(updated.group_id, old.group_id);
});
