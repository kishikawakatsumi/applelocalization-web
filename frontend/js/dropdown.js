"use strict";

export function closeSearchDropdowns() {
  for (
    const [root, trigger] of [["dropdown-filter", "dropdown-filter-trigger"], [
      "dropdown-advanced",
      "advanced-trigger",
    ]]
  ) {
    document.getElementById(root).classList.remove("is-active");
    document.getElementById(trigger).setAttribute("aria-expanded", "false");
  }
  document.getElementById("search-button").disabled = false;
}

export function setupDropdownTrigger() {
  const panels = [
    ["dropdown-filter", "dropdown-filter-trigger"],
    ["dropdown-advanced", "advanced-trigger"],
  ].map(([root, trigger]) => ({
    root: document.getElementById(root),
    trigger: document.getElementById(trigger),
  }));
  function close(panel) {
    panel.root.classList.remove("is-active");
    panel.trigger.setAttribute("aria-expanded", "false");
    if (panel.root.id === "dropdown-advanced") {
      document.getElementById("search-button").disabled = false;
    }
  }
  function closeAll() {
    panels.forEach(close);
  }
  for (const panel of panels) {
    close(panel);
    panel.trigger.addEventListener("click", () => {
      const open = !panel.root.classList.contains("is-active");
      closeAll();
      if (!open) return;
      panel.root.classList.add("is-active");
      panel.trigger.setAttribute("aria-expanded", "true");
      if (panel.root.id === "dropdown-advanced") {
        document.getElementById("search-button").disabled = true;
        document.getElementById("sa-search-field").focus();
      }
    });
    panel.root.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close(panel);
      panel.trigger.focus();
    });
  }
  // Labels and native select menus can temporarily have no focused element.
  // Close on a real focus destination outside, not a transient focusout(null).
  document.addEventListener("focusin", (event) => {
    for (const panel of panels) {
      if (!panel.root.contains(event.target)) close(panel);
    }
  });
  function blockDisabledSearch(event) {
    const button = document.getElementById("search-button");
    if (!button.disabled || !button.parentElement.contains(event.target)) {
      return false;
    }
    // Also cover clicks on the wrapper/icon (CSS or browser hit testing can
    // target them instead of the disabled button). Do not blur or close.
    event.preventDefault();
    event.stopImmediatePropagation();
    return true;
  }
  document.addEventListener("pointerdown", blockDisabledSearch, true);
  document.addEventListener("click", (event) => {
    if (blockDisabledSearch(event)) return;
    for (const panel of panels) {
      if (!panel.root.contains(event.target)) close(panel);
    }
  }, true);
  document.getElementById("dropdown-platform").addEventListener(
    "mouseover",
    closeAll,
  );
  document.getElementById("bundle-select").addEventListener("focus", closeAll);
  window.addEventListener("popstate", closeAll);
}
