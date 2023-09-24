import { RouteParams, RouterContext, State } from "../deps.ts";
import * as cache from "../services/cache.ts";

export async function get<
  R extends string,
  P extends RouteParams<R> = RouteParams<R>,
  // deno-lint-ignore no-explicit-any
  S extends State = Record<string, any>,
>(context: RouterContext<R, P, S>, key: string) {
  context.response.body = await cache.get(key);
}
