// Opt-in fixture only. Retains a stopped, uniquely named container for diagnostics.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { readOnlyRoleSQL } from "../../scripts/deploy/production-release.mjs";
import { baseImage } from "../../scripts/release/candidate-bundle-image.mjs";
assert.equal(process.env.ALLOW_PRODUCTION_ROLE_TEST, "1");
const nonce = randomBytes(12).toString("hex"),
  name = "localization-role-test-" + nonce,
  role = "web_" + nonce;
const docker = (args, input) =>
  execFileSync("docker", args, {
    input,
    encoding: "utf8",
    timeout: 120000,
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
const base = process.env.PRODUCTION_ROLE_TEST_IMAGE ?? baseImage;
assert.match(
  base,
  /^(sha256:[a-f0-9]{64}|groonga\/pgroonga@sha256:[a-f0-9]{64})$/,
);
let created = false;
try {
  docker([
    "run",
    "-d",
    "--name",
    name,
    "--label",
    "org.applelocalization.role-test=" + nonce,
    "--network",
    "none",
    "--tmpfs",
    "/var/lib/postgresql/data:rw",
    "-e",
    "POSTGRES_PASSWORD=" + randomBytes(32).toString("hex"),
    "-e",
    "POSTGRES_DB=applelocalization",
    base,
  ]);
  created = true;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    // Require the final TCP server, not the temporary socket-only initializer.
    try {
      docker([
        "exec",
        name,
        "pg_isready",
        "-h",
        "127.0.0.1",
        "-U",
        "postgres",
        "-d",
        "applelocalization",
      ]);
      ready = true;
      break;
    } catch {
      await delay(1000);
    }
  }
  assert.ok(ready);
  const sql = (user, input) =>
    docker([
      "exec",
      "-i",
      name,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      user,
      "-d",
      "applelocalization",
      "-At",
    ], input);
  sql(
    "postgres",
    `CREATE EXTENSION pgroonga;
    CREATE SCHEMA localization_fixture;
    CREATE TABLE localization_fixture.occurrence(target_text text);
    INSERT INTO localization_fixture.occurrence VALUES ('Open window');
    CREATE INDEX target_idx ON localization_fixture.occurrence USING pgroonga(target_text);`,
  );
  sql(
    "postgres",
    readOnlyRoleSQL(role, "b".repeat(64), ["localization_fixture"]),
  );
  assert.equal(
    sql(
      role,
      "SELECT target_text FROM localization_fixture.occurrence WHERE target_text &@ 'Open';",
    ),
    "Open window",
  );
  assert.equal(
    sql(
      role,
      "SELECT count(*) FROM pg_roles WHERE rolname=current_user AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole AND NOT rolreplication AND NOT rolbypassrls;",
    ),
    "1",
  );
  for (
    const statement of [
      "INSERT INTO localization_fixture.occurrence VALUES ('bad');",
      "UPDATE localization_fixture.occurrence SET target_text='bad';",
      "DELETE FROM localization_fixture.occurrence;",
      "DROP TABLE localization_fixture.occurrence;",
      "CREATE TABLE localization_fixture.bad(x int);",
      "SET ROLE postgres;",
    ]
  ) {
    assert.throws(() =>
      sql(role, "SET default_transaction_read_only=off;\n" + statement)
    );
  }
  assert.equal(
    sql("postgres", "SELECT count(*) FROM localization_fixture.occurrence;"),
    "1",
  );
  console.log(
    JSON.stringify({
      status: "read-only-role-search-and-write-denial-verified",
      container: name,
    }),
  );
} finally {
  if (created) {
    const c = JSON.parse(docker(["inspect", name]))[0];
    assert.equal(c.Config.Labels["org.applelocalization.role-test"], nonce);
    docker(["stop", "--time", "30", name]);
  }
}
