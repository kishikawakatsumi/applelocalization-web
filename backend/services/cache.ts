import { connect, Redis } from "../deps.ts";

export async function get(key: string) {
  if (Deno.env.get("REDIS_HOST") === undefined) {
    return null;
  }
  try {
    const redis = await connection();
    const value = await redis.get(key);
    redis.close();
    return value;
  } catch (error) {
    console.error(error);
    return null;
  }
}

export async function set(key: string, value: string) {
  if (Deno.env.get("REDIS_HOST") === undefined) {
    return;
  }
  try {
    const redis = await connection();
    await redis.set(key, value);
    redis.close();
  } catch (error) {
    console.error(error);
    return;
  }
}

async function connection(): Promise<Redis> {
  return await connect({
    hostname: Deno.env.get("REDIS_HOST") as string,
    port: 6379,
  });
}
