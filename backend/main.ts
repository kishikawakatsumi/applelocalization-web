import {
  Application,
  Eta,
  isHttpError,
  Router,
  send,
  Status,
  STATUS_TEXT,
} from "./deps.ts";
import { search, searchAdvanced } from "./handlers/search.ts";
import { healthCheck } from "./handlers/health.ts";
import { get } from "./handlers/get.ts";

const templates = `${Deno.cwd()}/dist/templates`;
const models = `${Deno.cwd()}/models`;

const eta = new Eta({
  views: templates,
});

// deno-lint-ignore no-explicit-any
const Platform: Record<string, any> = {
  ios: {
    latest: {
      name: "iOS",
      version: "16",
      path: "/",
      bundle: JSON.parse(
        await Deno.readTextFile(`${models}/ios16/bundles.json`),
      ),
      count: "4,013,858",
    },
    15: {
      name: "iOS",
      version: "15",
      path: "/ios/15",
      bundle: JSON.parse(
        await Deno.readTextFile(`${models}/ios15/bundles.json`),
      ),
      count: "5,643,937",
    },
  },
  macos: {
    latest: {
      name: "macOS",
      version: "13",
      path: "/macos",
      bundle: JSON.parse(
        await Deno.readTextFile(`${models}/macos13/bundles.json`),
      ),
      count: "5,379,251",
    },
    12: {
      name: "macOS",
      version: "12",
      path: "/macos/12",
      bundle: JSON.parse(
        await Deno.readTextFile(`${models}/macos12/bundles.json`),
      ),
      count: "25,292,608",
    },
  },
};

const router = new Router();
router
  .get("/healthz", async (context) => {
    await healthCheck(context);
  })
  .get("/", (context) => {
    context.response.body = renderBody(Platform.ios.latest);
  })
  .get("/ios", (context) => {
    context.response.body = renderBody(Platform.ios.latest);
  })
  .get("/macos", (context) => {
    context.response.body = renderBody(Platform.macos.latest);
  })
  .get(`/ios/${Platform.ios.latest.version}`, (context) => {
    context.response.body = renderBody(Platform.ios.latest);
  })
  .get(`/macos/${Platform.macos.latest.version}`, (context) => {
    context.response.body = renderBody(Platform.macos.latest);
  })
  .get("/ios/15", (context) => {
    context.response.body = renderBody(Platform.ios["15"]);
  })
  .get("/macos/12", (context) => {
    context.response.body = renderBody(Platform.macos["12"]);
  })
  .get("/api/:platform/search", async (context) => {
    if (context.request.url.searchParams.get("cache")) {
      const pathname = context.request.url.pathname;
      const search = context.request.url.search;
      const key = `${pathname}${search.replace("&cache=true", "")}`;
      await get(context, key);
    } else {
      const platform = context.params.platform;
      const version = Platform[platform].latest.version;
      await search(context, `${platform}${version}`);
    }
  })
  .get("/api/:platform/:version/search", async (context) => {
    if (context.request.url.searchParams.get("cache")) {
      const pathname = context.request.url.pathname;
      const search = context.request.url.search;
      const key = `${pathname}${search.replace("&cache=true", "")}`;
      await get(context, key);
    } else {
      const platform = context.params.platform;
      const version = context.params.version;
      await search(context, `${platform}${version}`);
    }
  })
  .get("/api/:platform/search/advanced", async (context) => {
    const platform = context.params.platform;
    const version = Platform[platform].latest.version;
    await searchAdvanced(context, `${platform}${version}`);
  })
  .get("/api/:platform/:version/search/advanced", async (context) => {
    const platform = context.params.platform;
    const version = context.params.version;
    await searchAdvanced(context, `${platform}${version}`);
  });

function renderBody(
  platform: {
    name: string;
    version: string;
    path: string;
    bundle: string;
    count: string;
  },
) {
  return `${
    eta.render("index.html", {
      platform: platform.name,
      version: platform.version,
      path: platform.path,
      bundles: platform.bundle,
      count: platform.count,
    })
  }`;
}

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
      const statusText = STATUS_TEXT[status];
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
    root: `${Deno.cwd()}/dist`,
  });
});

app.addEventListener("listen", ({ hostname, port, secure }) => {
  const scheme = secure ? "https" : "http";
  const host = hostname ?? "localhost";
  console.log(`Listening on: ${scheme}://${host}:${port}`);
});

await app.listen({ port: 8080 });
