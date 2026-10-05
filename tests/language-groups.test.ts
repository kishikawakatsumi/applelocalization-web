import { strict as assert } from "node:assert";
import {
  languageGroup,
  languageGroups,
} from "../backend/models/language_groups.ts";
import { languageMapping } from "../backend/models/languages.ts";
import { buildSearch, type Catalog } from "../backend/search/api.ts";

Deno.test("language filters group regional and device variants without changing raw locale codes", () => {
  for (
    const c of ["English", "en", "en-AU", "en_AU", "en_PH~mac", "en-IN", "Base"]
  ) assert.equal(languageGroup(c), "English", c);
  for (
    const c of ["da", "da-DK", "da-mac", "da~mac", "da-macos", "da~iphone"]
  ) assert.equal(languageGroup(c), "Danish", c);
  assert.equal(languageGroup("vi-VN-u-sd-vnct"), "Vietnamese");
  assert.equal(languageGroup("zh_CN~mac"), "Simplified Chinese");
  assert.equal(languageGroup("zh-Hant-CN"), "Traditional Chinese");
  assert.equal(languageGroup("zh-Hans-TW"), "Simplified Chinese");
  assert.equal(languageGroup("yue-Hant"), "Cantonese");
  assert.equal(languageGroup("nb-NO"), "Norwegian Bokmål");
  assert.equal(languageGroup("no-NO"), "Norwegian");
  assert.equal(languageGroup("fil"), "Filipino");
  for (const code of ["zh", "unknown", "en-arbitrary-device", ""]) {
    assert.equal(languageGroup(code), undefined);
  }
  for (const [name, codes] of Object.entries(languageMapping)) {
    for (const c of codes) {
      assert.equal(languageGroup(c), name, c);
    }
  }
  const codes = ["English", "en-AU", "da~mac", "da-DK", "unknown"];
  const groups = languageGroups(codes);
  assert.deepEqual(groups.English, ["English", "en-AU"]);
  assert.deepEqual(groups.Danish, ["da-DK", "da~mac"]);
  assert.deepEqual(Object.values(groups).flat().sort(), [...codes].sort());
});

Deno.test("group selection reaches every matching language ID; exact locale URL filters stay exact", () => {
  const codes = ["English", "en-AU", "en_PH~mac", "da-DK", "da~mac", "ja"];
  const catalog: Catalog = {
    manifest: "a".repeat(64),
    sourceId: "test",
    total: 6,
    bundles: [],
    languages: codes.map((code, i) => ({
      id: i + 1,
      code,
      raw: code,
      basis: "lproj",
      status: "identified",
      rows: 1,
    })),
    languageGroups: languageGroups(codes),
  };
  const args = (l: string) =>
    buildSearch(
      "ipsw_trial_test",
      catalog,
      new URLSearchParams({ q: "x", l }),
      false,
    ).args[0];
  assert.deepEqual(args("English"), [1, 2, 3]);
  assert.deepEqual(args("Danish"), [4, 5]);
  assert.deepEqual(args("en-AU"), [2]);
  assert.deepEqual(args("missing"), []);
});
