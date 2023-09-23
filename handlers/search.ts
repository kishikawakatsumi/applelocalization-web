import {
  RouteParams,
  RouterContext,
  State,
  Status,
  STATUS_TEXT,
} from "../deps.ts";
import { query } from "../services/db.ts";
import * as cache from "../services/cache.ts";
import { QueryBuilder } from "../utils/query_builder.ts";

import { languageMapping as iOS15 } from "../models/ios15/language_mappings.ts";
import { languageMapping as iOS16 } from "../models/ios16/language_mappings.ts";
import { languageMapping as macOS12 } from "../models/macos12/language_mappings.ts";
import { languageMapping as macOS13 } from "../models/macos13/language_mappings.ts";

const languageMappings: Record<string, { [key: string]: string[] }> = {
  "ios15": iOS15,
  "ios16": iOS16,
  "macos12": macOS12,
  "macos13": macOS13,
};

export async function search<
  R extends string,
  P extends RouteParams<R> = RouteParams<R>,
  // deno-lint-ignore no-explicit-any
  S extends State = Record<string, any>,
>(context: RouterContext<R, P, S>, platform: string) {
  setResponseHeader(context);

  const cacheKey = key(context);
  const cachedResponse = await cache.get(cacheKey);
  if (cachedResponse) {
    context.response.body = cachedResponse;
    return;
  }

  const searchWord = context.request.url.searchParams.get("q");

  const languages = context.request.url.searchParams.getAll("l") ?? [];
  const languageCodes = langCodes(platform, languages);

  const bundle = context.request.url.searchParams.get("b");
  if (!searchWord && !bundle) {
    sendResponse(context, Status.BadRequest);
    return;
  }
  console.log(
    `q: ${searchWord}, b: ${bundle}, l: ${languages}`,
  );

  const pageParam = context.request.url.searchParams.get("page") ?? "1";
  const page = Math.max(parseInt(pageParam), 1);

  const sizeParam = context.request.url.searchParams.get("size") ?? "200";
  const size = Math.max(Math.min(parseInt(sizeParam), 200), 1);

  const queryBuilder = new QueryBuilder();

  const groupResult = await query<{ group_id: string }>(
    queryBuilder.buildGroups(
      languageCodes,
      searchWord,
      bundle,
      platform,
    ),
    { searchWord, bundle },
  );
  const groups = groupResult.rows.map((row) => row.group_id);

  const countResult = await query<{ count: bigint }>(
    queryBuilder.build(
      ["COUNT(id) AS count"],
      languageCodes,
      groups,
      platform,
    ),
    {},
  );

  const count = Number(countResult.rows[0].count);
  const offset = (page - 1) * size;
  const totalPages = Math.ceil(count / size);

  const results = await query(
    queryBuilder.build(
      [
        "id",
        "group_id",
        "source",
        "target",
        "language",
        "file_name",
        "bundle_name",
      ],
      languageCodes,
      groups,
      platform,
      offset,
      size,
    ),
    { limit: size, offset },
  );
  console.log(results.query.args);

  const body = {
    data: results.rows,
    last_page: totalPages,
    total: count,
  };
  await cache.set(cacheKey, JSON.stringify(body));
  context.response.body = body;
}

export async function searchAdvanced<
  R extends string,
  P extends RouteParams<R> = RouteParams<R>,
  // deno-lint-ignore no-explicit-any
  S extends State = Record<string, any>,
>(context: RouterContext<R, P, S>, platform: string) {
  setResponseHeader(context);

  const cacheKey = key(context);
  const cachedResponse = await cache.get(cacheKey);
  if (cachedResponse) {
    context.response.body = cachedResponse;
    return;
  }

  const column = context.request.url.searchParams.get("c") ?? "";
  const fields: { [key: string]: string } = {
    "key": "source",
    "localization": "target",
    "language": "language",
    "file": "file_name",
    "bundle": "bundle_name",
  };
  const field = fields[column];
  if (!field) {
    sendResponse(context, Status.BadRequest);
    return;
  }

  const o = context.request.url.searchParams.get("o") ?? "";
  const operators: { [key: string]: string } = {
    "equal": "= $searchWord",
    "notEqual": "<> $searchWord",
    "startsWith": "LIKE $searchWord",
  };
  const operator = operators[o];
  if (!operator) {
    sendResponse(context, Status.BadRequest);
    return;
  }

  const languages = context.request.url.searchParams.getAll("l") || [];
  const languageCodes = langCodes(platform, languages);

  const langCondition = languageCodes
    .map((language) => `'${language}'`)
    .join(", ");

  const q = context.request.url.searchParams.get("q") ?? "";
  if (!q) {
    sendResponse(context, Status.BadRequest);
    return;
  }
  console.log(
    `c: ${column}, o: ${o}, q: ${q}, l: ${languages}`,
  );

  const searchWord = (() => {
    if (o === "startsWith") {
      const escaped = q
        .replaceAll("\\", "\\\\")
        .replaceAll("%", "\\%")
        .replaceAll("_", "\\_")
        .replaceAll("[", "\\[");
      return `${escaped}%`;
    } else {
      return q;
    }
  })();

  const pageParam = context.request.url.searchParams.get("page") || "1";
  const page = parseInt(pageParam);

  const sizeParam = context.request.url.searchParams.get("size") || "200";
  const maxSize = 200;
  const minSize = 1;
  const size = Math.max(Math.min(parseInt(sizeParam), maxSize), minSize);

  const countResult = await query<{ count: bigint }>(
    `
    SELECT
      COUNT(id) AS count
    FROM
      ${platform}
    WHERE
      language in (${langCondition}) AND
      ${field} ${operator};
    `,
    { searchWord },
  );

  const count = Number(countResult.rows[0].count);
  const offset = (page - 1) * size;
  const totalPages = Math.ceil(count / size);

  const results = await query(
    `
    SELECT
        id, group_id, source, target, language, file_name, bundle_name
    FROM
      ${platform}
    WHERE
      language in (${langCondition}) AND
      ${field} ${operator}
    ORDER BY id, group_id, language
    LIMIT $size OFFSET $offset
    `,
    { searchWord, offset, size },
  );
  console.log(results.query.args);

  const body = {
    data: results.rows,
    last_page: totalPages,
    total: count,
  };
  await cache.set(cacheKey, JSON.stringify(body));
  context.response.body = body;
}

function setResponseHeader<
  R extends string,
  P extends RouteParams<R> = RouteParams<R>,
  // deno-lint-ignore no-explicit-any
  S extends State = Record<string, any>,
>(context: RouterContext<R, P, S>) {
  context.response.headers.set("Content-Type", "application/json");
  context.response.headers.set(
    "Cache-Control",
    "s-maxage=86400, max-age=86400",
  );
}

function sendResponse<
  R extends string,
  P extends RouteParams<R> = RouteParams<R>,
  // deno-lint-ignore no-explicit-any
  S extends State = Record<string, any>,
>(context: RouterContext<R, P, S>, status: Status) {
  const statusText = STATUS_TEXT.get(status);
  context.response.status = status;
  context.response.body = `${status} | ${statusText}`;
}

function key<
  R extends string,
  P extends RouteParams<R> = RouteParams<R>,
  // deno-lint-ignore no-explicit-any
  S extends State = Record<string, any>,
>(context: RouterContext<R, P, S>) {
  return `${context.request.url.pathname}${context.request.url.search}`;
}

function langCodes(platform: string, languages: string[]) {
  const mapping = languageMappings[platform];
  const codes = languages.flatMap(
    (language) => mapping[language],
  );
  return codes.length ? codes : Object.values(mapping).flat();
}
