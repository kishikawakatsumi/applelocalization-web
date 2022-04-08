import { RouteParams, RouterContext, State, Status } from "../deps.ts";
import { ping } from "../services/db.ts";

export async function healthCheck<
  R extends string,
  P extends RouteParams<R> = RouteParams<R>,
  // deno-lint-ignore no-explicit-any
  S extends State = Record<string, any>,
>(context: RouterContext<R, P, S>) {
  const isOK = await ping();
  context.response.status = isOK ? Status.OK : Status.InternalServerError;
  context.response.body = { status: isOK ? "pass" : "fail" };
}
