// Public UI backed by the verified occurrence search API.
import { Eta } from "https://deno.land/x/eta@eta-v4.0.0-alpha.2/src/index.ts";
import { defaultLanguages, languageMapping } from "./models/languages.ts";

export function releasePageModel(target: any, catalog: any) {
  // UI choices are fixed, as in the public UI. Availability belongs to the
  // search result, not to whether a language checkbox is visible.
  const languages = Object.keys(languageMapping).map((
    name,
  ) => ({ name, checked: defaultLanguages.has(name) }));
  const platformId = target.platform.toLowerCase();
  const version = target.version.split(".")[0];
  return {
    platform: target.platform,
    platformId,
    version,
    path: `/${platformId}/${version}`,
    count: catalog.total.toLocaleString("en-US"),
    bundles: [
      ...new Set<string>(
        catalog.bundles.map((p: string) => p.split("/").at(-1)!),
      ),
    ].sort(),
    languages,
  };
}

export async function createReleaseWeb(
  targets: any[],
  api: (request: Request) => Promise<Response>,
  dist: string,
  { validationOnly = true } = {},
) {
  const eta = new Eta({ views: `${dist}/templates` });
  const models = await Promise.all(targets.map(async (target) => {
    const response = await api(
      new Request(
        `http://localhost/api/${target.platform.toLowerCase()}/${
          target.version.split(".")[0]
        }/catalog`,
      ),
    );
    if (!response.ok) throw Error("Cannot load release catalog");
    return releasePageModel(target, await response.json());
  }));
  models.sort((a, b) =>
    a.platformId.localeCompare(b.platformId) ||
    Number(b.version) - Number(a.version)
  );
  const pages = new Map(
    models.map((
      m,
    ) => [m.path, eta.render("index.html", { ...m, datasets: models })]),
  );
  for (const platform of ["ios", "macos"]) {
    const latest = models.find((m) => m.platformId === platform)!;
    pages.set(`/${platform}`, pages.get(latest.path)!);
    if (platform === "ios") pages.set("/", pages.get(latest.path)!);
  }
  const assets = new Map<string, { bytes: Uint8Array; type: string }>();
  const mime: Record<string, string> = {
    js: "text/javascript",
    css: "text/css",
    png: "image/png",
    ico: "image/x-icon",
    svg: "image/svg+xml",
    webmanifest: "application/manifest+json",
    woff2: "font/woff2",
  };
  async function load(dir: string, prefix = "") {
    for await (const entry of Deno.readDir(dir)) {
      if (
        entry.isSymlink || entry.name === "templates" ||
        entry.name === "report.html"
      ) continue;
      const path = `${prefix}/${entry.name}`;
      if (entry.isDirectory) await load(`${dir}/${entry.name}`, path);
      else if (entry.isFile) {
        assets.set(path, {
          bytes: await Deno.readFile(`${dir}/${entry.name}`),
          type: mime[entry.name.split(".").at(-1)!] ??
            "application/octet-stream",
        });
      }
    }
  }
  await load(dist);
  return async (request: Request) => {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/api/")) return api(request);
    if (!["GET", "HEAD"].includes(request.method)) {
      return new Response(null, { status: 405 });
    }
    if (path === "/healthz") {
      return Response.json({
        ready: true,
        datasets: models.length,
        validationOnly,
      });
    }
    const page = pages.get(path), asset = assets.get(path);
    if (!page && !asset) return new Response("Not found", { status: 404 });
    return new Response(
      request.method === "HEAD" ? null : page ?? asset!.bytes as BodyInit,
      {
        headers: {
          "Content-Type": page ? "text/html; charset=utf-8" : asset!.type,
          "Cache-Control": "no-store",
          "X-Content-Type-Options": "nosniff",
          "Content-Security-Policy":
            "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
        },
      },
    );
  };
}
