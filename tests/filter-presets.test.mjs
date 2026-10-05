import test from "node:test";
import assert from "node:assert/strict";
import { parsePresets } from "../frontend/js/filter_presets.js";
test("language presets validate stored data without treating locale aliases as groups", () => {
  const p = {
    name: "English variants",
    languages: ["Japanese"],
    locales: ["English", "en-AU"],
  };
  assert.deepEqual(parsePresets(JSON.stringify([p])), [p]);
  for (
    const value of [
      null,
      "oops",
      "{}",
      '[{"name":"bad","languages":{},"locales":[]}]',
    ]
  ) assert.deepEqual(parsePresets(value), []);
  assert.deepEqual(
    parsePresets(
      JSON.stringify([{ ...p, locales: [null] }, {
        ...p,
        name: "x".repeat(81),
      }]),
    ),
    [],
  );
});
