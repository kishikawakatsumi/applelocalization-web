// Opt-in tiny fixture on the review DB; all schemas and the role roll back.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  contextIndexStatements,
  contextSchema,
} from "../scripts/context-index-sql.mjs";
import { readOnlyRoleSQL } from "../scripts/production-release.mjs";
assert.equal(process.env.ALLOW_CONTEXT_INDEX_TEST, "1");
const nonce = randomBytes(8).toString("hex"),
  schema = "localization_ci_" + nonce,
  sidecar = contextSchema(schema);
const role = "web_" + randomBytes(12).toString("hex"),
  manifest = "f".repeat(64);
const text = (v) => v === null ? "NULL" : "'" + v.replaceAll("'", "''") + "'";
const rows = [
  [1, 1, 1, "Open", null],
  [2, 2, 2, "Open", null],
  [3, 1, 1, "Open", null],
  [4, 3, 1, "Open", null],
  [5, 1, 1, '"Open"', null],
  [6, 1, 1, null, '"Open"'],
  [7, 1, 1, "Case", null],
  [8, 1, 1, "case", null],
  [9, 1, 1, "e\u0301", null],
  [10, 1, 1, "é", null],
  [11, 1, 1, null, JSON.stringify("a\0b")],
  [12, 2, 2, null, JSON.stringify("a\0b")],
  [13, 1, 1, "", null],
  [14, 1, 1, null, JSON.stringify("\ud800")],
  [15, 4, 1, "Open", null],
];
const statements = contextIndexStatements({
  database: "localization_staging",
  schema,
  packageManifest: manifest,
});
const permissions = readOnlyRoleSQL(role, "b".repeat(64), [schema]).replace(
  /^BEGIN;\n/,
  "",
).replace(/COMMIT;\s*$/, "");
const sql = `BEGIN;
SET LOCAL statement_timeout='30s'; SET LOCAL lock_timeout='2s'; SET LOCAL standard_conforming_strings=on;
CREATE SCHEMA ${schema};
CREATE TABLE ${schema}.package(id int,manifest_sha256 text,report_json text,catalog_json text);
INSERT INTO ${schema}.package VALUES(1,'${manifest}','{"sourceId":"fixture"}','{"sourceId":"fixture"}');
CREATE TABLE ${schema}.language(id smallint,expected_rows bigint);
INSERT INTO ${schema}.language VALUES(1,13),(2,2);
CREATE TABLE ${schema}.resource(id int,table_id int);
INSERT INTO ${schema}.resource VALUES(1,1),(2,1),(3,2),(4,NULL);
CREATE TABLE ${schema}.occurrence(id bigint,resource_id int,language_id smallint,key_text text,key_json text);
INSERT INTO ${schema}.occurrence VALUES ${
  rows.map((r) =>
    "(" + r.map((v) => typeof v === "number" ? v : text(v)).join(",") + ")"
  ).join(",")
};
${statements.join(";\n")};
DO $verify$ DECLARE groups json; BEGIN
  SELECT json_agg(ids ORDER BY first_id) INTO groups FROM (
    SELECT min(occurrence_id) AS first_id,json_agg(occurrence_id ORDER BY occurrence_id) AS ids FROM ${sidecar}.member GROUP BY context_id) q;
  IF groups::jsonb<>'[[1,2,3],[4],[5],[6],[7],[8],[9],[10],[11,12],[13],[14]]'::jsonb THEN RAISE EXCEPTION 'Wrong identities'; END IF;
  IF (SELECT member_rows FROM ${sidecar}.metadata)<>14 OR (SELECT source_rows FROM ${sidecar}.metadata)<>15 THEN RAISE EXCEPTION 'Wrong coverage'; END IF;
END $verify$;
${permissions}
SET LOCAL ROLE ${role};
SELECT count(*) FROM ${sidecar}.member;
DO $denied$ BEGIN
  BEGIN DELETE FROM ${sidecar}.member; RAISE EXCEPTION 'Unexpected write permission';
  EXCEPTION WHEN insufficient_privilege THEN NULL; END;
END $denied$;
RESET ROLE;
ROLLBACK;
SELECT to_regnamespace('${schema}') IS NULL AND to_regnamespace('${sidecar}') IS NULL AND NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='${role}') AS removed;
`;
const child = spawn("ssh", [
  "-o",
  "BatchMode=yes",
  "192.168.1.175",
  "/usr/local/bin/docker exec -i localization-ui-3cac615c24f5-db-1 psql -X -q -At -v ON_ERROR_STOP=1 -U postgres -d localization_staging",
], { stdio: ["pipe", "pipe", "pipe"] });
let stdout = "", stderr = "";
child.stdout.on("data", (b) => {
  stdout += b;
});
child.stderr.on("data", (b) => {
  stderr += b;
});
child.stdin.on("error", () => {});
child.stdin.end(sql);
const code = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", resolve);
});
assert.equal(code, 0, stderr);
assert.equal(stdout.trim(), "14\nt");
console.log(
  "CI context migration identities, read-only role, and rollback verified",
);
