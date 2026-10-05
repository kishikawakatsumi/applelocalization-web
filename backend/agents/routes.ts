import { openapi } from "./openapi.ts";
import { createMcpHandler } from "./mcp.ts";

export async function createAgentRoutes(
  api: (request: Request) => Promise<Response>,
) {
  // Explicit allowlist: never turn an HTTP path into a filesystem path.
  const sources = [
    ["/llms.txt", "../../docs/llms.txt", "text/plain"],
    ["/docs/agent-access.md", "../../docs/agent-access.md", "text/markdown"],
    ["/docs/agent-skill.md", "../../docs/agent-skill.md", "text/markdown"],
    [
      "/skills/apple-localization/SKILL.md",
      "../../skills/apple-localization/SKILL.md",
      "text/markdown",
    ],
    [
      "/skills/apple-localization/references/api.md",
      "../../skills/apple-localization/references/api.md",
      "text/markdown",
    ],
    [
      "/skills/apple-localization/scripts/search.mjs",
      "../../skills/apple-localization/scripts/search.mjs",
      "text/plain",
    ],
  ];
  const documents = new Map<string, { body: string; type: string }>();
  for (const [path, source, type] of sources) {
    documents.set(path, {
      body: await Deno.readTextFile(new URL(source, import.meta.url)),
      type,
    });
  }
  documents.set("/openapi.json", {
    body: JSON.stringify(openapi, null, 2),
    type: "application/json",
  });
  const mcp = createMcpHandler(api);
  return (request: Request): Promise<Response> | Response | null => {
    const path = new URL(request.url).pathname;
    if (path === "/mcp") return mcp(request);
    const doc = documents.get(path);
    if (!doc) return null;
    if (!["GET", "HEAD"].includes(request.method)) {
      return new Response(null, {
        status: 405,
        headers: { Allow: "GET, HEAD" },
      });
    }
    return new Response(request.method === "HEAD" ? null : doc.body, {
      headers: {
        "Content-Type": `${doc.type}; charset=utf-8`,
        "Cache-Control": "no-store",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; frame-ancestors 'none'",
        Link: '</llms.txt>; rel="describedby"',
      },
    });
  };
}
