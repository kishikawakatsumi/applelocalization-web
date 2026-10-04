// One platform/version per request. Trusted metadata selects schemas, never HTTP input.
import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { languageGroups } from "../models/language_groups.ts";
import {
  buildSearch,
  type Catalog,
  loadCatalog,
  loadContextIndex,
  loadStrictSearchPolicy,
  presentRow,
  type Snapshot,
} from "./api.ts";

const hash = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
export function parseReleaseMetadata(
  bytes: Uint8Array,
  sha: string,
  bundles: Record<string, Uint8Array>,
) {
  assert.match(sha, /^[a-f0-9]{64}$/);
  assert.ok(bytes.length < 1024 * 1024);
  assert.equal(hash(bytes), sha);
  const catalog = JSON.parse(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
  );
  assert.equal(catalog.formatVersion, 1);
  assert.equal(catalog.status, "release-set-sql-context-prepared-not-restored");
  assert.equal(catalog.database, "localization_staging");
  assert.equal(catalog.searchScope, "one-platform-major-version");
  assert.equal(catalog.allPlannedTargets, true);
  assert.deepEqual(catalog.missingTargets, []);
  assert.equal(catalog.datasets.length, 12);
  assert.equal(new Set(catalog.datasets.map((d: any) => d.id)).size, 12);
  const schemas = new Set();
  assert.deepEqual(
    Object.keys(bundles).sort(),
    catalog.datasets.map((d: any) => d.id).sort(),
  );
  assert.equal(catalog.inputs.length, catalog.datasets.length);
  const parsed = catalog.datasets.map((d: any) => {
    assert.ok(["iOS", "macOS"].includes(d.platform));
    assert.match(d.version, /^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/);
    assert.match(d.build, /^[0-9]+[A-Za-z][0-9]+[a-z]?$/);
    assert.equal(d.id, d.platform.toLowerCase() + d.version.split(".")[0]);
    const pins = catalog.inputs.filter((p: any) => p.target === d.id);
    assert.equal(pins.length, 1);
    assert.ok(bundles[d.id].length < 1024 * 1024);
    assert.equal(hash(bundles[d.id]), pins[0].bundleSha256);
    const b = JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(bundles[d.id]),
    );
    assert.equal(b.formatVersion, 1);
    assert.equal(b.status, "candidate-sql-bundle-verified");
    for (const field of ["id", "platform", "version", "build"]) {
      assert.equal(b.target[field], d[field]);
    }
    assert.deepEqual(
      b.components.map(({ key, schema, packageManifest }: any) => ({
        key,
        schema,
        packageManifest,
      })),
      d.components,
    );
    assert.ok(b.components.some((c: any) => c.key === `${d.id}-os`));
    for (const c of b.components) {
      assert.match(
        c.key,
        new RegExp(`^${d.id}-(os|appos|systemos(?:-arm64e|-x86_64)?)$`),
      );
      assert.equal(
        c.schema,
        `localization_${d.id}_${d.build.toLowerCase()}_${
          c.key.slice(d.id.length + 1).replaceAll("-", "_")
        }`,
      );
      assert.match(c.schema, /^localization_[a-z0-9_]{1,40}$/);
      assert.ok(!schemas.has(c.schema));
      schemas.add(c.schema);
      assert.match(c.packageManifest, /^[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(c.rows) && c.rows >= 0);
      assert.ok(
        c.sourceId.startsWith(`${d.platform}-${d.version}-${d.build}-`),
      );
    }
    return b;
  });
  return { catalog, bundles: parsed };
}

export function resolveReviewRoute(path: string, datasets: any[]) {
  const m =
    /^\/api\/(ios|macos)(?:\/([1-9][0-9]*))?\/(catalog|search(?:\/advanced)?)$/
      .exec(path);
  if (!m) return null;
  const candidates = datasets.filter((d) => d.platform.toLowerCase() === m[1]);
  const target = m[2]
    ? candidates.find((d) => d.id === m[1] + m[2])
    : candidates.sort((a, b) =>
      Number(b.version.split(".")[0]) - Number(a.version.split(".")[0])
    )[0];
  return target ? { target, action: m[3] } : null;
}

export async function createReleaseReview(
  metadata: ReturnType<typeof parseReleaseMetadata>,
  snapshot: Snapshot,
  { validationOnly = true, contextIndexes = false } = {},
) {
  const loaded = new Map<string, { component: any; catalog: Catalog }[]>();
  for (const bundle of metadata.bundles) {
    const entries = [];
    for (const component of bundle.components) {
      const catalog = await snapshot(async (query) => {
        const c = await loadCatalog(query, component.schema, {
          durableManifest: component.packageManifest,
        });
        assert.equal(c.sourceId, component.sourceId);
        assert.equal(c.total, component.rows);
        c.languageGroups = languageGroups(c.languages.map((l) => l.code));
        c.searchPolicy = await loadStrictSearchPolicy(
          query,
          component.schema,
          c,
        );
        if (contextIndexes) {
          c.contextIndex = await loadContextIndex(query, component.schema, c);
        }
        return c;
      });
      entries.push({ component, catalog });
    }
    loaded.set(bundle.target.id, entries);
  }
  const headers = {
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  };
  const json = (body: unknown, status = 200) =>
    Response.json(body, { status, headers });
  return async (request: Request): Promise<Response> => {
    if (request.method !== "GET") {
      return new Response(null, {
        status: 405,
        headers: { ...headers, Allow: "GET" },
      });
    }
    const url = new URL(request.url);
    if (url.pathname === "/api/datasets") {
      return json({
        validationOnly,
        datasets: metadata.catalog.datasets,
      });
    }
    const route = resolveReviewRoute(url.pathname, metadata.catalog.datasets);
    if (!route) return json({ error: "Unknown OS/version or route" }, 404);
    const all = loaded.get(route.target.id)!;
    const selection = url.searchParams.get("component");
    const entries = selection
      ? all.filter((e) => e.component.key === selection)
      : all;
    if (!entries.length) {
      return json(
        { error: "Component does not belong to this OS/version" },
        400,
      );
    }
    if (route.action === "catalog") {
      return json({
        validationOnly,
        target: route.target,
        total: entries.reduce((n, e) => n + e.catalog.total, 0),
        languages: [
          ...new Set(
            entries.flatMap((e) => e.catalog.languages.map((l) => l.code)),
          ),
        ].sort(),
        languageGroups: languageGroups(
          entries.flatMap((e) => e.catalog.languages.map((l) => l.code)),
        ),
        bundles: [
          ...new Set(
            entries.flatMap((e) =>
              e.catalog.bundles.map((b) => b.path).filter(Boolean)
            ),
          ),
        ].sort(),
        components: all.map((e) => ({
          key: e.component.key,
          rows: e.catalog.total,
          sourceId: e.catalog.sourceId,
        })),
      });
    }
    try {
      const params = url.searchParams;
      const pageText = params.get("page") ?? "1",
        sizeText = params.get("size") ?? "200";
      if (!/^[1-9][0-9]*$/.test(pageText) || !/^[1-9][0-9]*$/.test(sizeText)) {
        return json({ error: "Invalid pagination" }, 400);
      }
      const page = Number(pageText), size = Math.min(Number(sizeText), 200);
      let skip = (page - 1) * size;
      if (!Number.isSafeInteger(skip)) {
        return json({ error: "Invalid pagination" }, 400);
      }
      // Stable component order, then the existing resource-table/key/language/id order.
      // No cross-component deduplication: equal words can have distinct provenance.
      const data: unknown[] = [], totals: Record<string, number> = {};
      await snapshot(async (query) => {
        await query("SET LOCAL pgroonga.match_escalation_threshold=-1");
        await query("SET LOCAL pgroonga.force_match_escalation=off");
        for (const { component, catalog } of entries) {
          const p = new URLSearchParams(params);
          p.set("page", "1");
          p.set("size", String(Math.max(1, size - data.length)));
          const search = buildSearch(
            component.schema,
            catalog,
            p,
            route.action === "search/advanced",
            undefined,
            { countOnly: data.length >= size },
          );
          if (search.emptyScope) {
            totals[component.key] = 0;
            continue;
          }
          // Offset stays a bound parameter, explicitly identified by the builder.
          search.args[search.offsetArgumentIndex] = skip;
          await query(`SET LOCAL search_path=${component.schema},public`);
          const [result] = await query(search.sql, search.args);
          const total = Number(result.total);
          assert.ok(Number.isSafeInteger(total) && total >= 0);
          totals[component.key] = total;
          if (data.length < size) {
            for (const row of JSON.parse(String(result.rows_json))) {
              data.push({
                ...presentRow(row, catalog.formatVersion ?? 1),
                component: component.key,
                dataset: route.target.id,
              });
            }
          }
          skip = Math.max(0, skip - total);
        }
      });
      const total = Object.values(totals).reduce((a, b) => a + b, 0);
      return json({
        data,
        total,
        last_page: Math.ceil(total / size),
        meta: {
          validationOnly,
          dataset: route.target.id,
          version: route.target.version,
          build: route.target.build,
          components: totals,
          sourceField: "resource-key",
          grouping: "component-resource-table-and-exact-key",
        },
      });
    } catch (error) {
      if (error instanceof Error && error.constructor.name === "BadRequest") {
        return json({ error: error.message }, 400);
      }
      if ((error as any).fields?.code === "57014") {
        return json({
          error:
            "検索がタイムアウトしました。言語やコンポーネントで絞り込んでください。",
        }, 503);
      }
      console.error(
        "Review query failed",
        error instanceof Error ? error.message : "unknown error",
      );
      return json({ error: "Review search failed" }, 500);
    }
  };
}
