import test from "node:test";
import assert from "node:assert/strict";
import {
  literalText,
  releaseLabel,
  visibleCharacters,
} from "../frontend/js/translation_context.js";

test("invisible character display preserves placeholders and distinguishes line endings", () => {
  const raw = " A\t%@\r\n%lld\nB\rC　";
  assert.equal(visibleCharacters(raw), "·A→\t%@␍↵\r\n%lld↵\nB␍\rC　");
  assert.equal(literalText(raw), raw);
  assert.equal(literalText({ plural: "%lld" }), '{"plural":"%lld"}');
  assert.equal(literalText(undefined), "");
});
test("release details use response metadata, never infer unavailable version or build", () => {
  assert.equal(
    releaseLabel({ dataset: "macos26", version: "26.7.1", build: "25G241" }),
    "macOS 26.7.1 · Build 25G241",
  );
  assert.equal(
    releaseLabel({ dataset: "ios18", version: "18.7" }),
    "iOS 18.7 · Build not available",
  );
  assert.equal(releaseLabel({ dataset: "macos26" }), "Not available");
  assert.equal(releaseLabel(null), "Not available");
});
