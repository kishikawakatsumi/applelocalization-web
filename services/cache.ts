import { connect } from "../deps.ts";

const redis = await connect({
  hostname: "applelocalization-redis",
  port: 10000,
});

export async function get(key: string) {
  return await redis.get(key);
}

export async function set(key: string, value: string) {
  await redis.set(key, value);
}
