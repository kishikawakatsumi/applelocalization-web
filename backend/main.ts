import { Pool } from "https://deno.land/x/postgres@ls/mod.ts";
import {
  createReleaseReview,
  parseReleaseMetadata,
} from "./search/release-set.ts";
import { createReleaseWeb } from "./web.ts";
import type { Query, Snapshot } from "./search/api.ts";

const bytes = await Deno.readFile("/release/release-set.json");
const catalog = JSON.parse(new TextDecoder().decode(bytes));
const bundles: Record<string, Uint8Array> = {};
for (const target of catalog.datasets) {
  if (!/^(ios|macos)[0-9]+$/.test(target.id)) throw Error("Invalid target");
  bundles[target.id] = await Deno.readFile(
    `/release/bundles/${target.id}.json`,
  );
}
const configPath = Deno.env.get("RELEASE_CONFIG");
const runtime = configPath
  ? JSON.parse(await Deno.readTextFile(configPath))
  : {};
const metadata = parseReleaseMetadata(
  bytes,
  Deno.env.get("RELEASE_SHA256") ?? runtime.sha256,
  bundles,
);
const password = (await Deno.readTextFile("/run/secrets/db_password"))
  .trimEnd();
const mode = Deno.env.get("RELEASE_MODE") ?? "review";
if (!["review", "production"].includes(mode)) {
  throw Error("Invalid release mode");
}
const validationOnly = mode !== "production";
const contextMode = Deno.env.get("CONTEXT_INDEX_MODE") ?? "off";
if (!["off", "auto"].includes(contextMode)) {
  throw Error("Invalid context index mode");
}
const user = Deno.env.get("RELEASE_DB_USER") ?? runtime.user ?? "postgres";
if (!validationOnly && !/^web_[a-f0-9]{24}$/.test(user)) {
  throw Error("Production requires a dedicated read-only database role");
}
const pool = new Pool(
  {
    hostname: "db",
    port: 5432,
    user,
    password,
    database: "localization_staging",
    applicationName: `localization-compose-${mode}`,
    options: {
      default_transaction_read_only: "on",
      statement_timeout: "30s",
      jit: "off",
    },
  },
  4,
  true,
);
const snapshot: Snapshot = async (work) => {
  const client = await pool.connect();
  try {
    await client.queryArray("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const query: Query = async (sql, args = []) =>
      (await client.queryObject<Record<string, unknown>>(sql, args)).rows;
    const result = await work(query);
    await client.queryArray("COMMIT");
    return result;
  } catch (error) {
    await client.queryArray("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
};
try {
  if (!validationOnly) {
    await snapshot(async (query) => {
      const [role] = await query(
        "SELECT rolsuper, rolcreatedb, rolcreaterole, rolreplication, rolbypassrls FROM pg_roles WHERE rolname = current_user",
      );
      if (!role || Object.values(role).some(Boolean)) {
        throw Error("Privileged database role refused");
      }
    });
  }
  const api = await createReleaseReview(metadata, snapshot, {
    validationOnly,
    contextIndexes: contextMode === "auto",
  });
  const app = await createReleaseWeb(
    metadata.catalog.datasets,
    api,
    "/app/dist",
    { validationOnly },
  );
  const server = Deno.serve(
    { hostname: "0.0.0.0", port: 8080 },
    async (request) => {
      if (new URL(request.url).pathname === "/healthz") {
        try {
          await snapshot((query) => query("SELECT 1"));
        } catch {
          return Response.json({ ready: false }, { status: 503 });
        }
      }
      return app(request);
    },
  );
  const stop = () => {
    void server.shutdown();
  };
  Deno.addSignalListener("SIGTERM", stop);
  Deno.addSignalListener("SIGINT", stop);
  console.log(
    `RELEASE_WEB_READY: existing UI, twelve releases, read-only ${mode}`,
  );
  await server.finished;
} finally {
  await pool.end();
}
