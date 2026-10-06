// Additive, logged sidecars. Source COPY payloads and their manifests stay unchanged.
import assert from "node:assert/strict";
import { validateReleaseDatabase } from "./database-name.mjs";
export function contextSchema(schema) {
  assert.match(schema, /^localization_[a-z0-9_]{1,40}$/);
  return schema.replace(/^localization_/, "context_");
}
export function contextIndexStatements({ database, schema, packageManifest }) {
  validateReleaseDatabase(database);
  const sidecar = contextSchema(schema);
  assert.match(packageManifest, /^[a-f0-9]{64}$/);
  return [
    `DO $guard$ BEGIN
      IF current_database()<>'${database}' THEN RAISE EXCEPTION 'Wrong database'; END IF;
      IF NOT pg_try_advisory_xact_lock(hashtextextended('${sidecar}',0)) THEN RAISE EXCEPTION 'Context build already running'; END IF;
      IF to_regnamespace('${sidecar}') IS NOT NULL THEN RAISE EXCEPTION 'Context sidecar already exists: ${sidecar}'; END IF;
      IF (SELECT manifest_sha256 FROM ${schema}.package WHERE id=1) IS DISTINCT FROM '${packageManifest}' THEN RAISE EXCEPTION 'Package manifest mismatch'; END IF;
    END $guard$`,
    `LOCK TABLE ${schema}.occurrence,${schema}.resource,${schema}.package IN SHARE MODE`,
    `DO $source$ DECLARE expected bigint; actual bigint; BEGIN
      SELECT COALESCE(sum(expected_rows),0) INTO expected FROM ${schema}.language;
      IF expected<0 OR expected>30000000 THEN RAISE EXCEPTION 'Context row capacity exceeded'; END IF;
      SELECT count(*) INTO actual FROM ${schema}.occurrence;
      IF actual<>expected THEN RAISE EXCEPTION 'Source count mismatch'; END IF;
      IF (SELECT report_json::json->>'sourceId' FROM ${schema}.package WHERE id=1)
        IS DISTINCT FROM (SELECT catalog_json::json->>'sourceId' FROM ${schema}.package WHERE id=1)
        THEN RAISE EXCEPTION 'Source identity mismatch'; END IF;
    END $source$`,
    `CREATE SCHEMA ${sidecar}`,
    `REVOKE ALL ON SCHEMA ${sidecar} FROM PUBLIC`,
    `CREATE TABLE ${sidecar}.member AS
      SELECT o.id AS occurrence_id,o.language_id,
        dense_rank() OVER (ORDER BY r.table_id,(o.key_text IS NULL),COALESCE(o.key_text,o.key_json) COLLATE "C") AS context_id
      FROM ${schema}.occurrence o JOIN ${schema}.resource r ON r.id=o.resource_id WHERE r.table_id IS NOT NULL`,
    `ALTER TABLE ${sidecar}.member ADD PRIMARY KEY(occurrence_id), ALTER COLUMN language_id SET NOT NULL, ALTER COLUMN context_id SET NOT NULL`,
    `CREATE INDEX member_context_language_idx ON ${sidecar}.member(context_id,language_id,occurrence_id)`,
    `ANALYZE ${sidecar}.member`,
    `CREATE TABLE ${sidecar}.metadata(id smallint PRIMARY KEY CHECK(id=1),version int NOT NULL,
      source_schema text NOT NULL,manifest_sha256 text NOT NULL,source_id text NOT NULL,source_rows bigint NOT NULL,
      member_rows bigint NOT NULL,contexts bigint NOT NULL,status text NOT NULL CHECK(status='verified'))`,
    `DO $coverage$ DECLARE expected bigint; members bigint; missing bigint; BEGIN
      SELECT count(*) FILTER (WHERE r.table_id IS NOT NULL),
        count(*) FILTER (WHERE r.table_id IS NOT NULL AND (m.occurrence_id IS NULL OR m.language_id<>o.language_id))
        INTO expected,missing FROM ${schema}.occurrence o JOIN ${schema}.resource r ON r.id=o.resource_id
        LEFT JOIN ${sidecar}.member m ON m.occurrence_id=o.id;
      SELECT count(*) INTO members FROM ${sidecar}.member;
      IF missing<>0 OR members<>expected THEN RAISE EXCEPTION 'Context coverage mismatch'; END IF;
    END $coverage$`,
    `INSERT INTO ${sidecar}.metadata SELECT 1,1,'${schema}','${packageManifest}',catalog_json::json->>'sourceId',
      (SELECT COALESCE(sum(expected_rows),0) FROM ${schema}.language),
      (SELECT count(*) FROM ${sidecar}.member),(SELECT count(DISTINCT context_id) FROM ${sidecar}.member),'verified'
      FROM ${schema}.package WHERE id=1`,
    `REVOKE ALL ON ALL TABLES IN SCHEMA ${sidecar} FROM PUBLIC`,
  ];
}
export function contextIndexMigration({ database, components }) {
  assert.ok(components?.length);
  assert.equal(
    new Set(components.map((c) => c.schema)).size,
    components.length,
  );
  return "\\set ON_ERROR_STOP on\n" +
    components.map((c) =>
      "BEGIN;\nSET LOCAL statement_timeout='10min';\nSET LOCAL lock_timeout='2s';\nSET LOCAL temp_file_limit='8GB';\n" +
      contextIndexStatements({ database, ...c }).join(";\n") + ";\nCOMMIT;\n"
    ).join("\n");
}
