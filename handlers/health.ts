import { RouteParams, RouterContext, State } from "../deps.ts";
import { ping } from "../services/db.ts";

export async function healthCheck<
  R extends string,
  P extends RouteParams<R> = RouteParams<R>,
  // deno-lint-ignore no-explicit-any
  S extends State = Record<string, any>,
>(context: RouterContext<R, P, S>) {
  context.response.body = await ping();
}
