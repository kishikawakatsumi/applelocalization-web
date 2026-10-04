// Search-filter groups only: never rewrite a resource's language or provenance.
import { languageMapping } from "./languages.ts";

const exact = new Map<string, string>();
const primary = new Map<string, string>();
for (const [name, codes] of Object.entries(languageMapping)) {
  exact.set(name, name);
  for (const code of codes) exact.set(code, name);
  for (const code of codes) {
    if (/^[a-z]{2,3}$/.test(code)) primary.set(code, name);
  }
}
primary.set("yue", "Cantonese");
// Historical English filter includes Base. This is a UI compatibility alias,
// not evidence that a Base resource is linguistically English.
exact.set("Base", "English");

export function languageGroup(code: string): string | undefined {
  // Strip only known Apple platform/device qualifiers, not arbitrary subtags.
  const locale = code.replace(
    /(?:-(?:iphoneos|macos|tvos|watchos|mac)|~(?:appletv|applewatch|ipad|iphone|mac))$/g,
    "",
  );
  const named = exact.get(locale);
  if (named) return named;
  try {
    const parsed = new Intl.Locale(locale.replaceAll("_", "-"));
    if (parsed.language === "zh") {
      // Keep the existing simplified/traditional distinction. Explicit script
      // wins over region; ambiguous Chinese is not guessed into either group.
      if (parsed.script === "Hans") return "Simplified Chinese";
      if (parsed.script === "Hant") return "Traditional Chinese";
      if (parsed.script) return undefined;
      if (["CN", "SG"].includes(parsed.region ?? "")) {
        return "Simplified Chinese";
      }
      if (["TW", "HK", "MO"].includes(parsed.region ?? "")) {
        return "Traditional Chinese";
      }
      return undefined;
    }
    return primary.get(parsed.language);
  } catch {
    return undefined;
  }
}

export function languageGroups(codes: string[]): Record<string, string[]> {
  const found = new Map<string, string[]>();
  for (const code of [...new Set(codes)].sort()) {
    const name = languageGroup(code) ?? code;
    const values = found.get(name) ?? [];
    values.push(code);
    found.set(name, values);
  }
  const order = [
    ...Object.keys(languageMapping),
    ...[...found.keys()].filter((n) => !Object.hasOwn(languageMapping, n))
      .sort(),
  ];
  return Object.fromEntries(
    order.filter((n) => found.has(n)).map((n) => [n, found.get(n)!]),
  );
}
