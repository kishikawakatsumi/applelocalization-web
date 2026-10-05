// Opt-in, read-only check of actual grouped filters on the running Compose UI.
import assert from "node:assert/strict";
import legacyOptions from "./fixtures/legacy-language-options.json" with {
  type: "json",
};
assert.equal(process.env.ALLOW_RELEASE_REVIEW_TEST, "1");
const base = "http://127.0.0.1:8084";
async function get(path) {
  const r = await fetch(base + path, { signal: AbortSignal.timeout(60000) });
  assert.equal(r.status, 200, path);
  return r;
}
const { datasets } = await (await get("/api/datasets")).json();
for (const d of datasets) {
  const scope = `/${d.platform.toLowerCase()}/${d.version.split(".")[0]}`;
  const c = await (await get(`/api${scope}/catalog`)).json();
  assert.deepEqual(
    Object.values(c.languageGroups).flat().sort(),
    c.languages.toSorted(),
  );
  const html = await (await get(scope)).text();
  const options = [
    ...html.matchAll(/name="language" type="checkbox" value="([^"]+)"/g),
  ].map((m) => m[1]);
  assert.deepEqual(options, legacyOptions.map((o) => o.name));
  assert.ok(options.includes("English") && options.includes("Danish"));
  const absent = ["Kazakh", "Oriya"].filter((n) => !c.languageGroups[n]);
  if (absent.length) {
    const p = new URLSearchParams({ q: "Open", size: "2" });
    absent.forEach((n) => p.append("l", n));
    const empty = await (await get(`/api${scope}/search?${p}`)).json();
    assert.equal(empty.total, 0);
    assert.deepEqual(empty.data, []);
  }
  for (const code of ["en-AU", "da-DK", "da~mac", "en_PH~mac"]) {
    assert.ok(!options.includes(code));
  }
  console.log(
    JSON.stringify({
      dataset: d.id,
      codes: c.languages.length,
      groups: options.length,
      allCodesCoveredByApi: true,
      originalUiChoicesPreserved: true,
    }),
  );
}
for (
  const [group, code] of [["English", "en-AU"], ["Danish", "da-DK"], [
    "Danish",
    "da~mac",
  ], ["English", "en_PH~mac"]]
) {
  const search = async (l) =>
    (await get(
      "/api/macos/27/search/advanced?" +
        new URLSearchParams({
          c: "language",
          o: "equal",
          q: code,
          l,
          size: "2",
        }),
    )).json();
  const grouped = await search(group), exact = await search(code);
  assert.ok(exact.total > 0, code);
  assert.equal(
    grouped.total,
    exact.total,
    `${group} must include every ${code} row`,
  );
  assert.ok(grouped.data.every((row) => row.language === code));
  console.log(
    JSON.stringify({
      group,
      code,
      rows: grouped.total,
      rawLocalePreserved: true,
    }),
  );
}
