// An explicit URL selection replaces defaults. With no l parameter, keep the
// server-rendered defaults. Preserve unknown/empty URL values until the user
// changes a checkbox, so an unsupported filter never silently becomes "all".
// The empty l= marker is different: it restores unchecked controls/all languages.
export function createLanguageSelection(searchParams, controls) {
  const checkboxes = Array.from(controls);
  const defaults = checkboxes.filter((c) => c.checked).map((c) => c.value);
  const known = new Set(checkboxes.map((checkbox) => checkbox.value));
  let unknown = [];
  let locales = [];
  let groups = {};
  function restore(params) {
    const requested = params.has("l") || params.has("locale")
      ? params.getAll("l")
      : defaults;
    locales = [...new Set(params.getAll("locale"))];
    const selected = new Set(requested);
    for (const checkbox of checkboxes) {
      checkbox.checked = selected.has(checkbox.value);
    }
    unknown = requested.filter((name) => !known.has(name));
  }
  restore(searchParams);
  for (const checkbox of checkboxes) {
    checkbox.addEventListener("change", () => {
      // Keep catalog-backed additions/raw codes when another group changes.
      // Truly unknown legacy values still follow the old checkbox behavior.
      unknown = unknown.filter((name) =>
        (Object.hasOwn(groups, name) ||
          Object.values(groups).some((codes) => codes.includes(name))) &&
        !(groups[checkbox.value] ?? []).includes(name)
      );
      locales = locales.filter((code) =>
        !(groups[checkbox.value] ?? []).includes(code)
      );
    });
  }
  const selection = () => [
    ...new Set([
      ...checkboxes.filter((checkbox) => checkbox.checked).map((checkbox) =>
        checkbox.value
      ),
      ...unknown,
    ]),
  ];
  selection.restore = restore;
  selection.locales = () => [...locales];
  selection.setGroups = (value) => {
    groups = value;
  };
  selection.set = (values, exact = []) => {
    const params = new URLSearchParams();
    for (const value of values.length || exact.length ? values : [""]) {
      params.append("l", value);
    }
    for (const code of exact) params.append("locale", code);
    restore(params);
  };
  return selection;
}
