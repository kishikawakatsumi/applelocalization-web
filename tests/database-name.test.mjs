import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  bundleDatabase,
  releaseDatabase,
  validateReleaseDatabase,
} from "../scripts/database-name.mjs";
import { readOnlyRoleSQL } from "../scripts/database-role.mjs";
import { contextIndexStatements } from "../scripts/context-index-sql.mjs";

test("new release database is explicit; old bundles retain their original database", () => {
  assert.equal(releaseDatabase, "applelocalization");
  assert.equal(bundleDatabase({ database: releaseDatabase }), releaseDatabase);
  assert.equal(bundleDatabase({}), "localization_staging");
  for (
    const database of [
      null,
      "",
      "postgres",
      "applelocalization;DROP DATABASE postgres",
      undefined,
    ]
  ) {
    assert.throws(() => validateReleaseDatabase(database));
    if (database !== undefined) {
      assert.throws(() => bundleDatabase({ database }));
    }
  }
});

test("role grants and context guards use the exact dataset database, without renaming it", () => {
  const role = "web_" + "a".repeat(24), password = "b".repeat(64);
  for (const database of [releaseDatabase, "localization_staging"]) {
    const grant = readOnlyRoleSQL(
      role,
      password,
      ["localization_fixture"],
      database,
    );
    assert.ok(
      grant.includes(`GRANT CONNECT ON DATABASE ${database} TO ${role};`),
    );
    const sql = contextIndexStatements({
      database,
      schema: "localization_fixture",
      packageManifest: "c".repeat(64),
    }).join(";\n");
    assert.ok(sql.includes(`current_database()<>'${database}'`));
    assert.doesNotMatch(grant + sql, /ALTER DATABASE|DROP DATABASE/);
  }
  assert.ok(
    readOnlyRoleSQL(role, password, ["localization_fixture"]).includes(
      "GRANT CONNECT ON DATABASE applelocalization",
    ),
  );
  assert.throws(() =>
    readOnlyRoleSQL(role, password, ["localization_fixture"], "postgres")
  );
});

test("SQL producers use the new name and Compose leaves the pinned image database unchanged", async () => {
  for (
    const path of [
      "scripts/candidate-pipeline.mjs",
      "scripts/collect-release-batch.mjs",
    ]
  ) {
    const source = await readFile(path, "utf8");
    assert.match(source, /database: releaseDatabase/);
    assert.doesNotMatch(source, /localization_staging/);
  }
  for (const path of ["compose.yml", "deploy/compose.existing.yml"]) {
    assert.doesNotMatch(await readFile(path, "utf8"), /POSTGRES_DB:/);
  }
  const dockerfile = await readFile("Dockerfile", "utf8");
  assert.match(dockerfile, /COPY scripts\/[^\n]*scripts\/database-name\.mjs/);
});
