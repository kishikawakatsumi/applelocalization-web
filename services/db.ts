import { Pool } from "../deps.ts";

const POSTGRES_PORT = 10000;
const POOL_CONNECTIONS = 16;
const pool = new Pool({
  hostname: Deno.env.get("POSTGRES_HOST"),
  port: POSTGRES_PORT,
  user: Deno.env.get("POSTGRES_USER"),
  password: Deno.env.get("POSTGRES_PASSWORD"),
  database: Deno.env.get("POSTGRES_DB"),
}, POOL_CONNECTIONS);

export async function query<T>(
  query: string,
  args: unknown[] | Record<string, unknown>,
) {
  const client = await pool.connect();
  const results = await client.queryObject<T>(query, args);
  client.release();
  return results;
}

export async function ping() {
  const client = await pool.connect();
  const results = await client.queryObject("SELECT 1;");
  client.release();
  return results.rowCount === 1;
}
