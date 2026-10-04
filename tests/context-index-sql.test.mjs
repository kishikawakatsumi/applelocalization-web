import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  contextIndexMigration,
  contextIndexStatements,
  contextSchema,
} from "../scripts/context-index-sql.mjs";
const input = {
  database: "localization_staging",
  schema: "localization_fixture",
  packageManifest: "a".repeat(64),
};
test("context migration is additive, atomic, pinned and validates every membership before publishing", () => {
  const statements = contextIndexStatements(input),
    sql = statements.join(";\n");
  assert.equal(contextSchema(input.schema), "context_fixture");
  assert.match(sql, /CREATE TABLE context_fixture.member AS/);
  assert.match(
    sql,
    /dense_rank\(\) OVER \(ORDER BY r.table_id,\(o.key_text IS NULL\),COALESCE\(o.key_text,o.key_json\) COLLATE "C"\)/,
  );
  assert.match(sql, /missing<>0 OR members<>expected/);
  assert.ok(
    sql.indexOf("Context coverage mismatch") <
      sql.indexOf("INSERT INTO context_fixture.metadata"),
  );
  assert.doesNotMatch(
    sql,
    /CREATE UNLOGGED|DROP |DELETE |UPDATE |CREATE TABLE localization_|INSERT INTO localization_/,
  );
  assert.match(sql, /REVOKE ALL ON ALL TABLES/);
  const migration = contextIndexMigration({
    database: input.database,
    components: [input],
  });
  assert.match(migration, /\\set ON_ERROR_STOP on\nBEGIN;/);
  assert.ok(migration.endsWith("COMMIT;\n"));
  for (
    const patch of [{ schema: "public" }, { schema: "localization_bad;drop" }, {
      database: "postgres",
    }, { packageManifest: "' OR TRUE" }]
  ) {
    assert.throws(() => contextIndexStatements({ ...input, ...patch }));
  }
  assert.throws(() =>
    contextIndexMigration({
      database: input.database,
      components: [input, input],
    })
  );
});
test("candidate and unified image preparation carry a hashed context migration, run after import", async () => {
  const source = await readFile(
    new URL("../scripts/candidate-bundle-image.mjs", import.meta.url),
    "utf8",
  );
  const init = await readFile(
    new URL(
      "../scripts/templates/candidate-bundle/initialize.sh",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(source, /contextIndexMigration/);
  assert.match(source, /files.push\(contextMigration\)/);
  assert.ok(init.indexOf("import.sql.gz") < init.indexOf("context-index.sql"));
  assert.ok(
    init.indexOf("context-index.sql") <
      init.indexOf("cp /opt/localization/identity"),
  );
});
