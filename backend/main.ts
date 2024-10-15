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

const templates = `${Deno.cwd()}/dist/templates`;
const models = `${Deno.cwd()}/models`;

const eta = new Eta({
  views: templates,
});

async function readBundle(platform: string, version: string) {
  return JSON.parse(
    await Deno.readTextFile(`${models}/${platform}${version}/bundles.json`),
  );
}

// deno-lint-ignore no-explicit-any
const Platform: Record<string, any> = {
  ios: {
    latest: {
      name: "iOS",
      version: "17",
      path: "/",
      bundle: await readBundle("ios", "17"),
      count: "9,175,537",
    },
    16: {
      name: "iOS",
      version: "16",
      path: "/",
      bundle: await readBundle("ios", "16"),
      count: "7,298,644",
    },
    15: {
      name: "iOS",
      version: "15",
      path: "/ios/15",
      bundle: await readBundle("ios", "15"),
      count: "5,643,937",
    },
  },
  macos: {
    latest: {
      name: "macOS",
      version: "14",
      path: "/macos",
      bundle: await readBundle("macos", "14"),
      count: "14,383,340",
    },
    13: {
      name: "macOS",
      version: "13",
      path: "/macos",
      bundle: await readBundle("macos", "13"),
      count: "13,254,016",
    },
    12: {
      name: "macOS",
      version: "12",
      path: "/macos/12",
      bundle: await readBundle("macos", "12"),
      count: "25,261,971",
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
  .get("/ios/16", (context) => {
    context.response.body = renderBody(Platform.ios["16"]);
  })
  .get("/ios/15", (context) => {
    context.response.body = renderBody(Platform.ios["15"]);
  })
  .get("/macos/13", (context) => {
    context.response.body = renderBody(Platform.macos["13"]);
  })
  .get("/macos/12", (context) => {
    context.response.body = renderBody(Platform.macos["12"]);
  })
  .get("/api/:platform/search", async (context) => {
    const platform = context.params.platform;
    const version = Platform[platform].latest.version;
    await search(context, `${platform}${version}`);
  })
  .get("/api/:platform/:version/search", async (context) => {
    const platform = context.params.platform;
    const version = context.params.version;
    await search(context, `${platform}${version}`);
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
    root: `${Deno.cwd()}/dist/`,
  });
});

app.addEventListener("listen", ({ hostname, port, secure }) => {
  const scheme = secure ? "https" : "http";
  const host = hostname ?? "localhost";
  console.log(`Listening on: ${scheme}://${host}:${port}`);
});

await app.listen({ port: 8080 });
