import { Application, connect, Pool, Router, send } from "./deps.ts";
import { QueryBuilder } from "./query_builder.ts";
import { languageMapping } from "./language_mappings.ts";

const POSTGRES_PORT = 10000;
const POOL_CONNECTIONS = 16;
const pool = new Pool({
  hostname: Deno.env.get("POSTGRES_HOST"),
  port: POSTGRES_PORT,
  user: Deno.env.get("POSTGRES_USER"),
  password: Deno.env.get("POSTGRES_PASSWORD"),
  database: Deno.env.get("POSTGRES_DB"),
}, POOL_CONNECTIONS);

const redis = await connect({
  hostname: "applelocalization-redis",
  port: 10000,
});

const router = new Router();
router
  .get("/healthz", (context) => {
    context.response.body = { status: "pass" };
  })
  .get("/api", async (context) => {
    context.response.headers.set("Content-Type", "application/json");
    context.response.headers.set(
      "Cache-Control",
      "s-maxage=604800, max-age=604800",
    );

    const cachedResponse = await redis.get(context.request.url.search);
    if (cachedResponse) {
      context.response.body = cachedResponse;
      return;
    }

    const client = await pool.connect();

    const searchWord = context.request.url.searchParams.get("q");

    const languages = context.request.url.searchParams.getAll("l") ?? [];
    const languageCodes = (() => {
      const codes = languages.flatMap(
        (language) => languageMapping[language],
      );
      return codes.length ? codes : Object.values(languageMapping).flat();
    })();

    const bundle = context.request.url.searchParams.get("b");
    console.log(
      `q: ${searchWord}, l: ${languages}, b: ${bundle}`,
    );

    const pageParam = context.request.url.searchParams.get("page") ?? "1";
    const page = Math.max(parseInt(pageParam), 1);

    const sizeParam = context.request.url.searchParams.get("size") ?? "200";
    const size = Math.max(Math.min(parseInt(sizeParam), 200), 1);

    const builder = new QueryBuilder();
    const countResult = await client.queryObject<{ count: bigint }>(
      builder.build(
        ["COUNT(id) AS count"],
        languageCodes.length
          ? languageCodes
          : Object.values(languageMapping).flat(),
        searchWord,
        bundle,
      ),
      { searchWord, bundle },
    );

    const count = countResult.rows[0].count;
    const offset = (page - 1) * size;
    const totalPages = Math.ceil(Number(count) / size);

    const results = await client.queryObject(
      builder.build(
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
        searchWord,
        bundle,
        offset,
        size,
      ),
      { searchWord, bundle, limit: size, offset },
    );
    console.log(results.query.args);

    const body = {
      last_page: totalPages,
      data: results.rows,
    };
    await redis.set(context.request.url.search, JSON.stringify(body));
    context.response.body = body;

    client.release();
  });

const app = new Application();

app.use(router.routes());
app.use(router.allowedMethods());

app.use(async (context) => {
  await send(context, context.request.url.pathname, {
    root: `${Deno.cwd()}/static`,
    index: "index.html",
  });
});

app.addEventListener("listen", ({ hostname, port, secure }) => {
  const scheme = secure ? "https" : "http";
  const host = hostname ?? "localhost";
  console.log(`Listening on: ${scheme}://${host}:${port}`);
});

await app.listen({ port: 8080 });
