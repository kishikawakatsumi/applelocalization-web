import test from "node:test";
import assert from "node:assert/strict";
import {
  structuredSearchIndexSQL,
  structuredSearchMigration,
} from "../scripts/structured-search.mjs";
import { occurrenceSQLLayout } from "../scripts/occurrence-staging.mjs";

test("new SQL and additive migration index lossless JSON without modifying original values", () => {
  const schema = "localization_fixture";
  const footer = occurrenceSQLLayout({
    schema,
    durable: true,
    database: "applelocalization",
  }).footer;
  assert.ok(footer.includes(structuredSearchIndexSQL(schema)));
  assert.equal((footer.match(/USING pgroonga/g) ?? []).length, 3);
  const sql = structuredSearchMigration({
    database: "applelocalization",
    components: [{ schema, packageManifest: "a".repeat(64) }],
  });
  assert.match(sql, /manifest_sha256/);
  assert.match(sql, /current_database\(\)/);
  assert.match(sql, /i.indisvalid AND i.indisready/);
  assert.match(sql, /i.indpred IS NULL AND i.indexprs IS NULL/);
  assert.match(sql, /IF existing_count=0 THEN/);
  assert.doesNotMatch(sql, /UPDATE |DELETE |DROP |TRUNCATE |jsonb|ALTER TABLE/);
});

test("migration refuses unpinned, duplicate or unsafe schema/database targets", () => {
  const c = { schema: "localization_fixture", packageManifest: "a".repeat(64) };
  for (const database of ["postgres", "template0", "x;DROP SCHEMA public"]) {
    assert.throws(() =>
      structuredSearchMigration({ database, components: [c] })
    );
  }
  for (
    const components of [[], [c, c], [{ ...c, packageManifest: "bad" }], [{
      ...c,
      schema: "public",
    }], [{ ...c, schema: "x;DROP" }]]
  ) {
    assert.throws(() =>
      structuredSearchMigration({
        database: "applelocalization",
        components,
      })
    );
  }
  assert.throws(() => structuredSearchIndexSQL("public"));
});
