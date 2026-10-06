import test from "node:test";
import assert from "node:assert/strict";
import { createLanguageSelection } from "../../frontend/js/language_selection.js";

function controls() {
  return [
    "English",
    "French",
    "German",
    "Italian",
    "Japanese",
    "Spanish",
    "Korean",
  ].map((value) => ({
    value,
    checked: value !== "Korean",
    handlers: {},
    addEventListener(event, handler) {
      this.handlers[event] = handler;
    },
  }));
}

test("exact locales remain distinct from group aliases and survive unrelated group changes", () => {
  const fields = controls();
  const selected = createLanguageSelection(
    new URLSearchParams("locale=English&locale=en-AU"),
    fields,
  );
  selected.setGroups({ English: ["English", "en", "en-AU"], Japanese: ["ja"] });
  assert.deepEqual(selected(), []);
  assert.deepEqual(selected.locales(), ["English", "en-AU"]);
  fields[4].checked = true;
  fields[4].handlers.change();
  assert.deepEqual(selected(), ["Japanese"]);
  assert.deepEqual(selected.locales(), ["English", "en-AU"]);
  fields[0].checked = true;
  fields[0].handlers.change();
  assert.deepEqual(selected.locales(), []);
  selected.set([], ["not-in-this-os"]);
  assert.deepEqual(selected(), []);
  assert.deepEqual(selected.locales(), ["not-in-this-os"]);
  selected.restore(new URLSearchParams());
  assert.deepEqual(selected.locales(), []);
  assert.equal(selected().length, 6);
});

test("absent language parameters keep the six defaults", () => {
  const fields = controls();
  const selected = createLanguageSelection(
    new URLSearchParams("q=name"),
    fields,
  );
  assert.deepEqual(selected(), fields.slice(0, 6).map((field) => field.value));
});

test("catalog additions and legacy raw locale URLs survive changes to other groups", () => {
  const fields = controls();
  const selected = createLanguageSelection(
    new URLSearchParams("l=NewLanguage&l=en-AU"),
    fields,
  );
  selected.setGroups({
    NewLanguage: ["new"],
    English: ["en", "en-AU"],
    Japanese: ["ja"],
  });
  fields[4].checked = true;
  fields[4].handlers.change();
  assert.deepEqual(selected(), ["Japanese", "NewLanguage", "en-AU"]);
  fields[0].checked = true;
  fields[0].handlers.change();
  assert.deepEqual(selected(), ["English", "Japanese", "NewLanguage"]);
});

test("history restoration resets defaults and unknown filters without attaching more listeners", () => {
  const fields = controls();
  const selected = createLanguageSelection(
    new URLSearchParams("l=Unknown"),
    fields,
  );
  const handler = fields[0].handlers.change;
  selected.restore(new URLSearchParams("l=Japanese"));
  assert.deepEqual(selected(), ["Japanese"]);
  selected.restore(new URLSearchParams());
  assert.deepEqual(selected(), fields.slice(0, 6).map((f) => f.value));
  selected.restore(new URLSearchParams("l="));
  assert.deepEqual(selected(), [""]);
  assert.equal(fields[0].handlers.change, handler);
});

test("explicit language URLs replace defaults, including multiple and repeated values", () => {
  for (
    const [query, expected] of [
      ["l=Japanese", ["Japanese"]],
      ["l=Korean&l=Japanese&l=Japanese", ["Japanese", "Korean"]],
    ]
  ) {
    const fields = controls();
    const selected = createLanguageSelection(
      new URLSearchParams(query),
      fields,
    );
    assert.deepEqual(selected(), expected);
    assert.deepEqual(
      fields.filter((field) => field.checked).map((field) => field.value),
      expected,
    );
  }
});

test("unknown/empty URL filters are not widened and user changes replace them", () => {
  for (const name of ["Unknown", "", "__proto__", "A&B"]) {
    const fields = controls();
    const selected = createLanguageSelection(
      new URLSearchParams({ l: name }),
      fields,
    );
    assert.deepEqual(selected(), [name]);
    assert.ok(fields.every((field) => !field.checked));
    fields[4].checked = true;
    fields[4].handlers.change();
    assert.deepEqual(selected(), ["Japanese"]);
    fields[4].checked = false;
    fields[4].handlers.change();
    assert.deepEqual(selected(), []); // Existing no-filter behavior after user action.
  }
});
