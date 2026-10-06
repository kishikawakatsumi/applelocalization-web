// Opt-in read-only acceptance against the running loopback review server.
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
assert.equal(process.env.ALLOW_RELEASE_REVIEW_TEST, "1");
const base = process.env.REVIEW_BASE ?? "http://127.0.0.1:8083";
assert.match(base, /^http:\/\/127\.0\.0\.1:\d+$/);
async function get(path, status = 200) {
  const r = await fetch(base + path, { signal: AbortSignal.timeout(125000) });
  assert.equal(r.status, status, path);
  return r.json();
}
const all = await get("/api/datasets");
assert.equal(all.datasets.length, 12);
const results = [];
let cursor = 0;
async function worker() {
  while (cursor < all.datasets.length) {
    const d = all.datasets[cursor++],
      path = `/api/${d.platform.toLowerCase()}/${d.version.split(".")[0]}`;
    const c = await get(path + "/catalog");
    assert.equal(c.target.id, d.id);
    assert.ok(c.languages.includes("ja"));
    assert.ok(c.languages.length > 7);
    const start = performance.now();
    const r = await get(
      path + "/search?" +
        new URLSearchParams({ q: "設定", l: "Japanese", size: "2" }),
    );
    assert.equal(r.meta.dataset, d.id);
    assert.ok(r.total > 0);
    assert.equal(r.data.length, 2);
    assert.equal(
      Object.values(r.meta.components).reduce((a, b) => a + b, 0),
      r.total,
    );
    for (const row of r.data) {
      assert.equal(row.dataset, d.id);
      assert.ok(row.component.startsWith(d.id + "-"));
      assert.ok(
        row.provenance.source_id.startsWith(
          `${d.platform}-${d.version}-${d.build}-`,
        ),
      );
    }
    results.push({
      id: d.id,
      languages: c.languages.length,
      bundles: c.bundles.length,
      metadataRows: c.total,
      searchMatches: r.total,
      searchMs: Math.round(performance.now() - start),
    });
    console.log(JSON.stringify(results.at(-1)));
  }
}
await Promise.all([worker(), worker()]);
for (const platform of ["ios", "macos"]) {
  const r = await get(
    `/api/${platform}/search/advanced?c=key&o=equal&q=Open&l=Japanese&l=English&size=2`,
  );
  assert.equal(r.meta.dataset, platform + "27");
  assert.ok(r.data.every((row) => row.source === "Open"));
}
await get("/api/ios/99/search?q=x", 404);
await get("/api/ios/27/search?q=x&component=macos27-os", 400);
await get("/api/ios/27/search", 400);
assert.equal(
  (await fetch(base + "/api/datasets", { method: "POST" })).status,
  405,
);
assert.equal((await fetch(base + "/ios/99")).status, 404);
const output = {
  status: "all-twelve-review-api-verified",
  datasets: results,
  aliasesVerified: true,
  unknownScopeRefused: true,
  productionChanged: false,
};
if (process.env.REVIEW_RESULT) {
  await writeFile(
    process.env.REVIEW_RESULT,
    JSON.stringify(output, null, 2) + "\n",
    { flag: "wx" },
  );
}
console.log(JSON.stringify({ status: output.status, targets: results.length }));
