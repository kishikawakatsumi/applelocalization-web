import test from "node:test";
import assert from "node:assert/strict";
import {
  isSearchStart,
  readSearchState,
  searchAPIURL,
  searchPageURL,
  searchParameters,
  searchStateIdentity,
} from "../../frontend/js/search_state.js";

test("unchecked languages are retained in page URLs but omitted from normal/advanced API filters", () => {
  for (const advanced of [false, true]) {
    for (const languages of [[], [""], ["", ""]]) {
      const state = {
        advanced,
        q: "Open",
        b: "",
        c: "key",
        o: "equal",
        languages,
        locales: [],
      };
      const page = new URL(
        searchPageURL("/macos/26", state),
        "http://example.test",
      );
      assert.ok(page.searchParams.has("l"));
      const restored = readSearchState(page.searchParams, [
        "English",
        "Japanese",
      ]);
      const api = new URL(
        searchAPIURL("/macos/26", restored),
        "http://example.test",
      );
      assert.equal(api.searchParams.has("l"), false);
    }
    for (const name of ["Japanese", "Unknown"]) {
      const state = readSearchState(new URLSearchParams("q=Open&l=&l=" + name));
      state.advanced = advanced;
      const api = new URL(
        searchAPIURL("/macos/26", state),
        "http://example.test",
      );
      assert.deepEqual(api.searchParams.getAll("l"), [name]);
    }
    const exact = readSearchState(new URLSearchParams("q=Open&l=&locale=en"));
    exact.advanced = advanced;
    const api = new URL(
      searchAPIURL("/macos/26", exact),
      "http://example.test",
    );
    assert.equal(api.searchParams.has("l"), false);
    assert.deepEqual(api.searchParams.getAll("locale"), ["en"]);
  }
});

test("exact locales use a separate optional URL parameter and survive round trips", () => {
  const state = readSearchState(
    new URLSearchParams("q=Open&locale=English&locale=en-AU"),
    ["Japanese"],
  );
  assert.deepEqual(state.languages, []);
  assert.deepEqual(state.locales, ["English", "en-AU"]);
  assert.equal(searchParameters(state).has("l"), false);
  assert.deepEqual(readSearchState(searchParameters(state)), state);
  assert.notEqual(
    searchStateIdentity(state),
    searchStateIdentity({ ...state, languages: ["English"], locales: [] }),
  );
  assert.equal(
    searchStateIdentity(state),
    searchStateIdentity({ ...state, locales: ["en-AU", "English", "English"] }),
  );
});

test("language order and repeated values do not create a different history state", () => {
  const a = readSearchState(
    new URLSearchParams("q=Open&l=Japanese&l=English&l=English"),
  );
  const b = readSearchState(new URLSearchParams("l=English&q=Open&l=Japanese"));
  assert.equal(searchStateIdentity(a), searchStateIdentity(b));
  assert.equal(
    searchStateIdentity({ ...a, languages: [] }),
    searchStateIdentity({ ...a, languages: [""] }),
  );
});

test("normal/advanced search round-trips reserved characters and whitespace with legacy GET keys", () => {
  for (const advanced of [false, true]) {
    for (
      const q of [
        "A&B",
        "C++",
        "#tag",
        "100%",
        "a=b?c/d",
        "日本語 + & #",
        " leading and trailing ",
      ]
    ) {
      const s = {
        advanced,
        q,
        b: "A&B + #.app",
        c: advanced ? "localization" : "",
        o: advanced ? "equal" : "",
        languages: ["English", "Japanese", "A+B&"],
        locales: [],
      };
      const page = new URL(
        searchPageURL("/macos/26", s),
        "http://example.test",
      );
      assert.equal(page.hash, "");
      assert.deepEqual(readSearchState(page.searchParams), s);
      const api = new URL(searchAPIURL("/macos/26", s), "http://example.test");
      assert.equal(api.searchParams.get("q"), q);
      assert.equal(api.searchParams.get("b"), s.b);
      assert.equal(
        api.pathname,
        advanced ? "/api/macos/26/search/advanced" : "/api/macos/26/search",
      );
    }
  }
});
test("old URLs, absent vs empty languages, aliases and cross-OS links stay scoped", () => {
  const old = readSearchState(
    new URLSearchParams("q=a+b&b=Terminal.app&l=English&l=Japanese"),
  );
  assert.equal(old.q, "a b");
  assert.deepEqual(
    readSearchState(new URLSearchParams(), ["English"]).languages,
    ["English"],
  );
  assert.deepEqual(
    readSearchState(new URLSearchParams("l="), ["English"]).languages,
    [""],
  );
  const none = searchParameters({ ...old, languages: [] });
  assert.equal(none.has("l"), true);
  assert.equal(none.get("l"), "");
  assert.equal(
    new URL(searchPageURL("/ios/27", old), "http://example.test").searchParams
      .get("b"),
    "Terminal.app",
  );
  assert.match(searchAPIURL("/", old), /^\/api\/ios\/search\?/);
  assert.match(searchAPIURL("/macos", old), /^\/api\/macos\/search\?/);
  assert.equal(readSearchState(new URLSearchParams("o=equal&q=x")).c, "key");
});
test("empty search uses an API-only random bundle; explicit searches and pagination stay scoped", () => {
  const s = readSearchState(new URLSearchParams("page=4&size=200"), [
    "English",
  ]);
  assert.equal(searchPageURL("/macos", s), "/macos?l=English");
  assert.equal(
    new URL(searchAPIURL("/macos", s, "Sample.app"), "http://example.test")
      .searchParams.get("b"),
    "Sample.app",
  );
  for (const explicit of [{ ...s, q: "Open" }, { ...s, advanced: true }]) {
    assert.equal(
      new URL(
        searchAPIURL("/macos", explicit, "Sample.app"),
        "http://example.test",
      ).searchParams.has("b"),
      false,
    );
  }
  assert.equal(
    new URL(
      searchAPIURL("/macos", { ...s, b: "Terminal.app" }, "Sample.app"),
      "http://example.test",
    ).searchParams.get("b"),
    "Terminal.app",
  );
  assert.equal(isSearchStart(s), true);
  assert.equal(isSearchStart({ ...s, b: "Terminal.app" }), false);
  assert.equal(isSearchStart({ ...s, q: " " }), false);
  assert.equal(isSearchStart({ ...s, advanced: true }), false);
  assert.equal(searchParameters(s).has("page"), false);
});
