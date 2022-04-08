import {
  Application,
  configure,
  isHttpError,
  renderFile,
  Router,
  send,
  Status,
  STATUS_TEXT,
} from "./deps.ts";
import { search, searchAdvanced } from "./handlers/search.ts";
import { healthCheck } from "./handlers/health.ts";
import { get } from "./handlers/get.ts";

const views = `${Deno.cwd()}/views`;
configure({
  views,
});
const bundles = {
  ios: JSON.parse(await Deno.readTextFile(`${views}/ios/bundles.json`)),
  macos: JSON.parse(await Deno.readTextFile(`${views}/macos/bundles.json`)),
};

const cacheBuster = `?v=${Deno.env.get("RENDER_GIT_COMMIT")}`;

const router = new Router();
router
  .get("/healthz", (context) => {
    context.response.body = { status: "pass" };
  })
  .get("/ping", async (context) => {
    await healthCheck(context);
  })
  .get("/", async (context) => {
    context.response.body = `${await renderFile("index.html", {
      platform: "ios",
      bundles: bundles.ios,
      cb: cacheBuster,
    })}`;
  })
  .get("/ios", async (context) => {
    context.response.body = `${await renderFile("index.html", {
      platform: "ios",
      bundles: bundles.ios,
      cb: cacheBuster,
    })}`;
  })
  .get("/macos", async (context) => {
    context.response.body = `${await renderFile("index.html", {
      platform: "macos",
      bundles: bundles.macos,
      cb: cacheBuster,
    })}`;
  })
  .get("/api/:platform/search", async (context) => {
    if (context.request.url.searchParams.get("cache")) {
      const pathname = context.request.url.pathname;
      const search = context.request.url.search;
      const key = `${pathname}${search.replace("&cache=true", "")}`;
      await get(context, key);
    } else {
      await search(context, context.params.platform);
    }
  })
  .get("/api/:platform/search/advanced", async (context) => {
    await searchAdvanced(context, context.params.platform);
  });

const app = new Application();

app.use(async (context, next) => {
  await next();
  console.log(
    `${context.request.method} | ${context.response.status} | ${context.request.url}`,
  );
});

app.use(async (context, next) => {
  try {
    await next();
  } catch (error) {
    if (isHttpError(error)) {
      const status = error.status;
      const statusText = STATUS_TEXT.get(status);
      context.response.status = status;
      context.response.body = `${status} | ${statusText}`;

      if (error.status === Status.NotFound) {
        return;
      }
    }
    throw error;
  }
});

app.use(router.routes());
app.use(router.allowedMethods());

app.use(async (context) => {
  await send(context, context.request.url.pathname, {
    root: `${Deno.cwd()}/static`,
  });
});

app.addEventListener("listen", ({ hostname, port, secure }) => {
  const scheme = secure ? "https" : "http";
  const host = hostname ?? "localhost";
  console.log(`Listening on: ${scheme}://${host}:${port}`);
});

await app.listen({ port: 8080 });
