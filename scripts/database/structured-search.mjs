// Additive index migration. Original JSON, row identities and package manifests
// remain unchanged. Search the serialized value, including its dictionary keys,
// just as the JSON shown in Localization; never cast lossless JSON text to jsonb.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

export function structuredSearchIndexSQL(schema) {
  assert.match(schema, /^(ipsw_trial|localization)_[a-z0-9_]{1,40}$/);
  return `CREATE INDEX occurrence_target_json_fts_idx ON ${schema}.occurrence USING pgroonga (target_json);`;
}

export function structuredSearchMigration({ database, components }) {
  assert.match(database ?? "", /^[a-z][a-z0-9_]{0,62}$/);
  assert.ok(!["postgres", "template0", "template1"].includes(database));
  assert.ok(components?.length);
  assert.equal(
    new Set(components.map((c) => c.schema)).size,
    components.length,
  );
  const statements = components.map(({ schema, packageManifest }) => {
    assert.match(schema, /^localization_[a-z0-9_]{1,40}$/);
    assert.match(packageManifest, /^[a-f0-9]{64}$/);
    return `\\echo Structured search: ${schema}
BEGIN;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='0';
DO $migration$
DECLARE existing_count integer;
BEGIN
  IF current_database() <> '${database}' THEN RAISE EXCEPTION 'Wrong database'; END IF;
  IF (SELECT manifest_sha256 FROM ${schema}.package WHERE id=1) IS DISTINCT FROM '${packageManifest}' THEN
    RAISE EXCEPTION 'Package manifest mismatch: ${schema}';
  END IF;
  SELECT count(*) INTO existing_count FROM pg_index i
    JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid
    JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_am a ON a.oid=c.relam
    WHERE n.nspname='${schema}' AND t.relname='occurrence' AND a.amname='pgroonga'
    AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL
    AND i.indnkeyatts=1 AND pg_get_indexdef(i.indexrelid,1,true)='target_json';
  IF existing_count=0 THEN
    ${structuredSearchIndexSQL(schema)}
  ELSIF existing_count<>1 THEN
    RAISE EXCEPTION 'Ambiguous JSON search indexes: ${schema}';
  END IF;
END $migration$;
COMMIT;`;
  });
  return `\\set ON_ERROR_STOP on
\\timing on
${statements.join("\n")}
\\echo Structured search indexes ready
`;
}

if (
  process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const { values } = parseArgs({
    options: {
      database: { type: "string" },
      bundle: { type: "string", multiple: true },
    },
  });
  assert.ok(
    values.bundle?.length,
    "Supply verified bundle.json files with --bundle",
  );
  const bundles = await Promise.all(
    values.bundle.map(async (p) => JSON.parse(await readFile(p, "utf8"))),
  );
  process.stdout.write(structuredSearchMigration({
    database: values.database,
    components: bundles.flatMap((b) => b.components),
  }));
}
