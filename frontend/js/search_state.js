// Keep the public GET vocabulary: q, b, repeated l, and advanced c/o.
export function readSearchState(params, defaults = []) {
  const advanced = !!(params.get("c") || params.get("o"));
  return {
    q: params.get("q") ?? "",
    b: params.get("b") ?? "",
    c: advanced ? params.get("c") || "key" : "",
    o: advanced ? params.get("o") || "equal" : "",
    advanced,
    languages: params.has("l") || params.has("locale")
      ? params.getAll("l")
      : [...defaults],
    locales: params.getAll("locale"),
  };
}

export function searchParameters(state) {
  const params = new URLSearchParams();
  if (state.advanced) {
    params.set("c", state.c);
    params.set("o", state.o);
  }
  if (state.q) params.set("q", state.q);
  if (state.b) params.set("b", state.b);
  // l= records "all languages" in page URLs instead of restoring the defaults.
  // It is a UI-state marker, not a language code to send to the search API.
  for (
    const language of state.languages.length || state.locales?.length
      ? state.languages
      : [""]
  ) {
    params.append("l", language);
  }
  for (const locale of state.locales ?? []) params.append("locale", locale);
  return params;
}

export function searchPageURL(pathname, state) {
  const query = searchParameters(state).toString();
  return pathname + (query ? "?" + query : "");
}

export function searchStateIdentity(state) {
  return searchParameters({
    ...state,
    languages: [
      ...new Set(
        state.languages.length || state.locales?.length
          ? state.languages
          : [""],
      ),
    ]
      .sort(),
    locales: [...new Set(state.locales ?? [])].sort(),
  }).toString();
}

export function isSearchStart(state) {
  return !state.q && !state.b && !state.advanced;
}

export function searchAPIURL(pathname, state, fallbackBundle = "") {
  const platform = pathname.startsWith("/macos") ? "macos" : "ios";
  const version = pathname.split("/")[2];
  const params = searchParameters(state);
  const languages = params.getAll("l").filter((language) => language !== "");
  params.delete("l");
  for (const language of languages) params.append("l", language);
  if (isSearchStart(state) && fallbackBundle) params.set("b", fallbackBundle);
  return `/api/${platform}${version ? "/" + version : ""}/search${
    state.advanced ? "/advanced" : ""
  }?${params.toString()}`;
}
