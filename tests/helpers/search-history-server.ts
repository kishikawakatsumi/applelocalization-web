// Synthetic API + actual built frontend. No real DB or public service is used.
import { createReleaseWeb } from "../../backend/web.ts";
const requests: string[] = [];
const attempts = new Map<string, number>();
const api = async (request: Request) => {
  const url = new URL(request.url);
  if (url.pathname.endsWith("/catalog")) {
    return Response.json({
      total: 400,
      languages: ["en", "ja", "English", "en-AU"],
      languageGroups: { English: ["English", "en", "en-AU"], Japanese: ["ja"] },
      bundles: url.pathname.includes("/macos/")
        ? [
          "Terminal.app",
          "A&B + #.app",
          ...Array.from(
            { length: 180 },
            (_, i) => `Example${String(i).padStart(3, "0")}.framework`,
          ),
        ]
        : ["Mobile.app"],
    });
  }
  requests.push(url.pathname + url.search);
  const q = url.searchParams.get("q") ?? "sample";
  if (q === "slow") await new Promise((r) => setTimeout(r, 800));
  const page = Number(url.searchParams.get("page") ?? 1);
  if (q === "context-ui") {
    const source = 'Shared <img src=x onerror="window.contextXSS=true"> key';
    const target =
      'First line %@\nSecond line\t  %lld <img src=x onerror="window.contextXSS=true">';
    return Response.json({
      total: 205,
      last_page: 2,
      meta: { dataset: "macos26", version: "26.1", build: "25B78" },
      data: Array.from({
        length: Math.max(0, Math.min(200, 205 - (page - 1) * 200)),
      }, (_, i) => {
        const index = (page - 1) * 200 + i;
        const second = index >= 201 && index <= 202;
        const component = index >= 203 ? "macos26-appos" : "macos26-os";
        const bundle = second ? "B.app" : "A.app";
        return {
          id: index >= 203 ? index - 202 : index + 1,
          group_id: second ? "table-b" : "table-a",
          source,
          target,
          language: "en",
          file_name: second ? "Menu.strings" : "Localizable.strings",
          bundle_name: bundle,
          component,
          target_kind: "text",
          target_value: target,
          provenance: {
            bundle_path: "/Applications/" + bundle,
            image_path: "/Applications/" + bundle +
              "/Contents/Resources/en.lproj/" +
              (second ? "Menu.strings" : "Localizable.strings"),
          },
        };
      }),
    });
  }
  const key = `${q}:${page}`;
  const attempt = (attempts.get(key) ?? 0) + 1;
  attempts.set(key, attempt);
  if (q === "retry-page" && page === 2 && attempt === 1) {
    return Response.json({ error: "検索がタイムアウトしました。" }, {
      status: 503,
    });
  }
  if (q.startsWith("retry-first") && attempt === 1) {
    return new Response("Unavailable", { status: 500 });
  }
  if (q === "slow-page" && page === 2) {
    await new Promise((r) => setTimeout(r, 1200));
  }
  // No language parameter means no language filter. Explicit invalid values
  // still return no results, so the test catches accidental empty API codes.
  const empty = !url.searchParams.has("locale") &&
    url.searchParams.has("l") &&
    url.searchParams.getAll("l").every((l) => l === "" || l === "Unknown");
  const count = empty
    ? 0
    : ["paging", "retry-page", "slow-page"].includes(q)
    ? 400
    : 1;
  const data = Array.from({
    length: Math.min(200, Math.max(0, count - (page - 1) * 200)),
  }, (_, i) => ({
    id: (page - 1) * 200 + i + 1,
    group_id: "group",
    source: q,
    target: q,
    language: "en",
    file_name: "Localizable.strings",
    bundle_name: "A&B + #.app",
  }));
  return Response.json({
    data,
    total: count,
    last_page: Math.ceil(count / 200),
  });
};
const app = await createReleaseWeb(
  [
    { platform: "macOS", version: "26.1" },
    { platform: "iOS", version: "27.0" },
  ],
  api,
  "dist",
);
Deno.serve({
  hostname: "127.0.0.1",
  port: 0,
  onListen: ({ port }) => console.log("FIXTURE_PORT=" + port),
}, (request) => {
  if (new URL(request.url).pathname === "/fixture-requests") {
    return Response.json(requests);
  }
  return app(request);
});
