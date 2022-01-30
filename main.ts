import {
  Application,
  isHttpError,
  Router,
  send,
  Status,
  STATUS_TEXT,
} from "./deps.ts";
import { search, searchAdvanced } from "./handlers/search.ts";

const router = new Router();
router
  .get("/healthz", (context) => {
    context.response.body = { status: "pass" };
  })
  .get("/api", async (context) => {
    await search(context);
  })
  .get("/api/ios/search", async (context) => {
    await search(context);
  })
  .get("/api/cs", async (context) => {
    await searchAdvanced(context);
  })
  .get("/api/ios/search/advanced", async (context) => {
    await searchAdvanced(context);
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
    index: "index.html",
  });
});

app.addEventListener("listen", ({ hostname, port, secure }) => {
  const scheme = secure ? "https" : "http";
  const host = hostname ?? "localhost";
  console.log(`Listening on: ${scheme}://${host}:${port}`);
});

await app.listen({ port: 8080 });
