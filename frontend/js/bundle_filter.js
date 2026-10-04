"use strict";

// A bundle-only enhancement. The original select remains the search state;
// language controls and the rest of the form are not moved or restyled.
export function initBundleFilter() {
  const select = document.getElementById("bundle-select");
  const native = select.closest(".select");
  const width = native.getBoundingClientRect().width;
  const root = document.createElement("div");
  root.className = "bundle-picker";
  root.style.width = `${width}px`;
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.id = "bundle-trigger";
  trigger.className = "button is-small bundle-trigger";
  trigger.setAttribute("aria-expanded", "false");
  trigger.setAttribute("aria-controls", "bundle-menu");
  trigger.setAttribute("aria-label", "Bundle");
  const label = document.createElement("span");
  label.className = "bundle-trigger-label";
  const arrow = document.createElement("span");
  arrow.className = "bundle-trigger-arrow has-text-grey";
  arrow.setAttribute("aria-hidden", "true");
  const arrowIcon = document.createElement("i");
  arrowIcon.className = "fa-solid fa-angle-down";
  arrow.append(arrowIcon);
  trigger.append(label, arrow);
  const menu = document.createElement("div");
  menu.id = "bundle-menu";
  menu.className = "bundle-menu";
  menu.hidden = true;
  const query = document.createElement("input");
  query.id = "bundle-query";
  query.type = "search";
  query.className = "input is-small";
  query.placeholder = "Filter bundles…";
  query.setAttribute("aria-label", "Filter bundles");
  query.autocomplete = "off";
  const list = document.createElement("div");
  list.id = "bundle-options";
  list.className = "bundle-options";
  list.setAttribute("role", "group");
  list.setAttribute("aria-label", "Bundles");
  const empty = document.createElement("div");
  empty.className = "bundle-empty";
  empty.setAttribute("role", "status");
  empty.textContent = "No matching bundles";
  empty.hidden = true;
  menu.append(query, list, empty);
  root.append(trigger, menu);
  native.after(root);
  native.classList.add("bundle-native");
  native.hidden = true;
  let key;
  let buttons = [];
  let selected;

  function sync() {
    label.textContent = select.value || "All bundles";
    trigger.title = label.textContent;
    selected?.setAttribute("aria-pressed", "false");
    selected = buttons.find((b) => b.dataset.bundleValue === select.value);
    selected?.setAttribute("aria-pressed", "true");
  }
  function render() {
    const term = query.value.toLowerCase();
    const nextKey = JSON.stringify([
      term,
      select.options.length,
      select.options[select.options.length - 1]?.value,
    ]);
    if (key === nextKey) {
      sync();
      return;
    }
    key = nextKey;
    const fragment = document.createDocumentFragment();
    buttons = [];
    let matches = 0;
    // No cap: keep every bundle and every filtered match available.
    for (const option of select.options) {
      if (option.value && !option.text.toLowerCase().includes(term)) continue;
      if (option.value) matches++;
      const button = document.createElement("button");
      button.type = "button";
      button.className = "bundle-option";
      button.textContent = option.value ? option.text : "All bundles";
      button.dataset.bundleValue = option.value;
      button.setAttribute(
        "aria-pressed",
        String(option.value === select.value),
      );
      button.addEventListener("click", () => {
        select.value = option.value;
        select.dispatchEvent(new Event("change", { bubbles: true }));
        sync();
        close();
        trigger.focus();
      });
      buttons.push(button);
      fragment.append(button);
    }
    list.replaceChildren(fragment);
    list.scrollTop = 0;
    empty.hidden = matches !== 0;
    sync();
  }
  function layout() {
    if (menu.hidden) return;
    const rect = trigger.getBoundingClientRect();
    const viewport = window.visualViewport;
    const leftEdge = viewport?.offsetLeft ?? 0;
    const topEdge = viewport?.offsetTop ?? 0;
    const rightEdge = leftEdge + (viewport?.width ?? innerWidth);
    const bottomEdge = topEdge + (viewport?.height ?? innerHeight);
    const menuWidth = Math.min(
      Math.max(rect.width, 360),
      rightEdge - leftEdge - 16,
    );
    const top = Math.max(topEdge + 8, rect.bottom + 3);
    menu.style.left = `${
      Math.max(leftEdge + 8, Math.min(rect.left, rightEdge - menuWidth - 8))
    }px`;
    menu.style.top = `${top}px`;
    menu.style.width = `${menuWidth}px`;
    // Use all available viewport height, rather than a fixed 300px list.
    menu.style.height = `${Math.max(0, bottomEdge - top - 8)}px`;
  }
  function close() {
    menu.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
  }
  function open() {
    document.getElementById("dropdown-filter").classList.remove("is-active");
    query.value = "";
    menu.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    render();
    layout();
    query.focus();
  }
  trigger.addEventListener("click", () => menu.hidden ? open() : close());
  trigger.addEventListener("keydown", (event) => {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      open();
    }
  });
  query.addEventListener("input", render);
  root.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      close();
      trigger.focus();
    }
    if (
      !menu.hidden &&
      ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)
    ) {
      if (event.target === query && !event.key.startsWith("Arrow")) return;
      event.preventDefault();
      const current = buttons.indexOf(document.activeElement);
      const next = event.key === "Home"
        ? 0
        : event.key === "End"
        ? buttons.length - 1
        : event.key === "ArrowDown"
        ? Math.min(current + 1, buttons.length - 1)
        : current <= 0
        ? -1
        : current - 1;
      (next < 0 ? query : buttons[next])?.focus();
    }
  });
  document.addEventListener("click", (event) => {
    if (!root.contains(event.target)) close();
  }, true);
  root.addEventListener("focusout", (event) => {
    if (!root.contains(event.relatedTarget)) close();
  });
  window.addEventListener("resize", layout);
  window.visualViewport?.addEventListener("resize", layout);
  window.addEventListener("popstate", close);
  select.addEventListener("change", sync);
  sync();
  return { sync, close };
}
