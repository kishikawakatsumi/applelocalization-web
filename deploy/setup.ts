// One-shot service: additive indexes + dedicated read-only role, never source rewrites.
import { Pool } from "https://deno.land/x/postgres@ls/mod.ts";
import { parseReleaseMetadata } from "../backend/search/release-set.ts";
import {
  loadCatalog,
  loadContextIndex,
  loadStrictSearchPolicy,
} from "../backend/search/api.ts";
import type { Query } from "../backend/search/api.ts";
import { contextIndexStatements } from "../scripts/context-index-sql.mjs";
import { structuredSearchIndexSQL } from "../scripts/structured-search.mjs";
import { readOnlyRoleSQL } from "../scripts/database-role.mjs";
import { createHash } from "node:crypto";

const bytes = await Deno.readFile("/release/release-set.json");
const sha = createHash("sha256").update(bytes).digest("hex");
const bundles: Record<string, Uint8Array> = {};
for (const target of JSON.parse(new TextDecoder().decode(bytes)).datasets) {
  if (!/^(ios|macos)[0-9]+$/.test(target.id)) throw Error("Invalid target");
  bundles[target.id] = await Deno.readFile(
    `/release/bundles/${target.id}.json`,
  );
}
const metadata = parseReleaseMetadata(bytes, sha, bundles);
const adminPassword = (await Deno.readTextFile("/admin/password")).trim();
const appPassword = (await Deno.readTextFile("/app-secret/db_password")).trim();
const role = "web_" + sha.slice(0, 24);
const pool = new Pool(
  {
    hostname: "db",
    port: 5432,
    database: metadata.catalog.database,
    user: "postgres",
    password: adminPassword,
    options: { statement_timeout: "30min", jit: "off" },
  },
  1,
  true,
);
const client = await pool.connect();
const query: Query = async (sql, args = []) =>
  (await client.queryObject<Record<string, unknown>>(sql, args)).rows;
try {
  // Serialize setup services sharing this database. Connection close releases the lock.
  const [lock] = await query(
    "SELECT pg_try_advisory_lock(184256488) AS locked",
  );
  if (!lock.locked) throw Error("Another setup service is running");
  const components = metadata.catalog.datasets.flatMap((d: any) =>
    d.components
  );
  for (const c of components) {
    console.log(`Preparing search indexes: ${c.key}`);
    const catalog = await loadCatalog(query, c.schema, {
      durableManifest: c.packageManifest,
    });
    const [jsonIndex] = await query(
      `SELECT count(*)::int AS count FROM pg_index i JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_class x ON x.oid=i.indexrelid JOIN pg_am a ON a.oid=x.relam WHERE n.nspname=$1 AND t.relname='occurrence' AND a.amname='pgroonga' AND i.indisvalid AND i.indisready AND i.indpred IS NULL AND i.indexprs IS NULL AND i.indnkeyatts=1 AND pg_get_indexdef(i.indexrelid,1,true)='target_json'`,
      [c.schema],
    );
    if (jsonIndex.count === 0) await query(structuredSearchIndexSQL(c.schema));
    await loadStrictSearchPolicy(query, c.schema, catalog);
    if (!(await loadContextIndex(query, c.schema, catalog))) {
      await query("BEGIN");
      try {
        await query("SET LOCAL lock_timeout='5s'");
        for (
          const statement of contextIndexStatements({
            database: metadata.catalog.database,
            schema: c.schema,
            packageManifest: c.packageManifest,
          })
        ) await query(statement);
        await query("COMMIT");
      } catch (error) {
        await query("ROLLBACK");
        throw error;
      }
      await loadContextIndex(query, c.schema, catalog);
    }
  }
  const roles = await query(
    "SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1",
    [role],
  );
  if (!roles.length) {
    await query(
      readOnlyRoleSQL(
        role,
        appPassword,
        components.map((c: any) => c.schema),
        metadata.catalog.database,
      ),
    );
  } else if (Object.values(roles[0]).some(Boolean)) {
    throw Error("Privileged web role refused");
  }
  // Verify persistent credentials and access before marking setup complete.
  const appPool = new Pool(
    {
      hostname: "db",
      port: 5432,
      database: metadata.catalog.database,
      user: role,
      password: appPassword,
    },
    1,
    true,
  );
  try {
    const app = await appPool.connect();
    try {
      const result = await app.queryObject<
        { default_transaction_read_only: string }
      >("SHOW default_transaction_read_only");
      if (result.rows[0].default_transaction_read_only !== "on") {
        throw Error("Read-only role required");
      }
      for (const c of components) {
        await app.queryArray(`SELECT id FROM ${c.schema}.occurrence LIMIT 0`);
      }
    } finally {
      app.release();
    }
  } finally {
    await appPool.end();
  }
  await Deno.writeTextFile(
    "/release/runtime.json.tmp",
    JSON.stringify({ sha256: sha, user: role }) + "\n",
    { mode: 0o644 },
  );
  await Deno.rename("/release/runtime.json.tmp", "/release/runtime.json");
  console.log("Search indexes and read-only Web access ready.");
} finally {
  client.release();
  await pool.end();
}
