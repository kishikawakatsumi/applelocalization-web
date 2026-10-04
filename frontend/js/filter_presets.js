export const PRESET_KEY = "applelocalization.language-presets.v1";
export function parsePresets(raw) {
  try {
    const values = JSON.parse(raw);
    if (!Array.isArray(values)) return [];
    return values.filter((p) =>
      p && typeof p.name === "string" && p.name.length > 0 &&
      p.name.length <= 80 &&
      Array.isArray(p.languages) && p.languages.length <= 200 &&
      p.languages.every((s) => typeof s === "string" && s.length <= 200) &&
      Array.isArray(p.locales) && p.locales.length <= 1000 &&
      p.locales.every((s) => typeof s === "string" && s.length <= 200)
    ).slice(0, 30);
  } catch {
    return [];
  }
}
