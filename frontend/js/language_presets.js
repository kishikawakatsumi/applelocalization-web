import { parsePresets, PRESET_KEY } from "./filter_presets.js";

export function initLanguagePresets(selection, changed) {
  const select = document.getElementById("language-presets");
  const nameField = document.getElementById("preset-name");
  const save = document.getElementById("preset-save");
  const remove = document.getElementById("preset-delete");
  const notice = document.getElementById("preset-notice");
  const englishJapanese = { languages: ["English", "Japanese"], locales: [] };
  let presets = [];
  function message(text) {
    notice.textContent = text;
    notice.hidden = !text;
  }
  function read() {
    try {
      return parsePresets(localStorage.getItem(PRESET_KEY));
    } catch {
      message(
        "Browser storage is unavailable. Language selection still works.",
      );
      return null;
    }
  }
  function write(next) {
    try {
      localStorage.setItem(PRESET_KEY, JSON.stringify(next));
      presets = next;
      return true;
    } catch {
      message(
        "Could not save changes. Browser storage may be disabled or full.",
      );
      return false;
    }
  }
  function selectedPreset() {
    return select.value === "default:en-ja"
      ? englishJapanese
      : presets.find((p) => "saved:" + p.name === select.value);
  }
  function render(value = "") {
    select.replaceChildren(
      new Option("", ""),
      new Option("English + Japanese", "default:en-ja"),
    );
    for (const preset of presets) {
      select.add(new Option(preset.name, "saved:" + preset.name));
    }
    select.value = value;
    remove.disabled = !select.value.startsWith("saved:");
  }
  const key = (languages, locales) =>
    JSON.stringify([
      [...new Set(languages.filter(Boolean))].sort(),
      [...new Set(locales)].sort(),
    ]);
  function sync() {
    const preset = selectedPreset();
    if (
      preset &&
      key(preset.languages, preset.locales) !==
        key(selection(), selection.locales())
    ) {
      select.value = "";
    }
    remove.disabled = !select.value.startsWith("saved:");
  }
  // Native selects emit input before change. Do not let the header sync this
  // pending choice against the old checkboxes and clear it before applying it.
  // The change handler below refreshes the links after updating the selection.
  select.addEventListener("input", (event) => event.stopPropagation());
  select.addEventListener("change", () => {
    const preset = selectedPreset();
    remove.disabled = !select.value.startsWith("saved:");
    if (!preset) return;
    selection.set(preset.languages, preset.locales);
    changed();
    message("");
  });
  save.addEventListener("click", () => {
    const name = nameField.value.trim();
    if (!name || name.length > 80) {
      message("Enter a preset name (up to 80 characters).");
      nameField.focus();
      return;
    }
    // Re-read before writing to retain changes made in another tab.
    const latest = read();
    if (!latest) return;
    if (latest.some((p) => p.name === name)) {
      message(
        "That name is already saved. Choose another name or delete it first.",
      );
      return;
    }
    if (latest.length >= 30) {
      message("Up to 30 presets can be saved.");
      return;
    }
    if (
      !write([...latest, {
        name,
        languages: selection().filter(Boolean),
        locales: selection.locales(),
      }])
    ) return;
    render("saved:" + name);
    nameField.value = "";
    message("");
  });
  nameField.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      save.click();
    }
  });
  remove.addEventListener("click", () => {
    const preset = selectedPreset();
    if (!select.value.startsWith("saved:") || !preset) return;
    const latest = read();
    if (!latest || !write(latest.filter((p) => p.name !== preset.name))) return;
    render();
    message("");
  });
  window.addEventListener("storage", (event) => {
    if (event.key !== PRESET_KEY && event.key !== null) return;
    const latest = read();
    if (!latest) return;
    presets = latest;
    render(select.value);
    sync();
  });
  presets = read() ?? [];
  render();
  return { sync };
}
