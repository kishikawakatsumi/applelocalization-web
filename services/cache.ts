import { connect, Redis } from "../deps.ts";

export async function get(key: string) {
  const redis = await connection();
  const value = await redis.get(key);
  redis.close();
  return value;
}

export async function set(key: string, value: string) {
  const redis = await connection();
  await redis.set(key, value);
  redis.close();
}

async function connection(): Promise<Redis> {
  return await connect({
    hostname: "applelocalization-redis",
    port: 10000,
  });
}
