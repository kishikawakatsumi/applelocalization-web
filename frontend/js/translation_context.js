import { icon } from "@fortawesome/fontawesome-svg-core";
import { faCopy } from "@fortawesome/free-regular-svg-icons";
import { faCheck } from "@fortawesome/free-solid-svg-icons";

// The search response already carries provenance. Never reconstruct paths or
// infer release versions from bundle names; legacy responses may lack both.
export function literalText(value) {
  return typeof value === "string" ? value : JSON.stringify(value) ?? "";
}

export function visibleCharacters(value) {
  return value.replace(/\r\n|\r|\n|\t| /g, (character) =>
    ({
      " ": "·",
      "\t": "→\t",
      "\r\n": "␍↵\r\n",
      "\r": "␍\r",
      "\n": "↵\n",
    })[character]);
}

export function releaseLabel(meta = {}) {
  const platform = /^(macos|ios)\d+$/.exec(meta?.dataset ?? "")?.[1];
  if (!platform || !meta?.version) return "Not available";
  return `${platform === "macos" ? "macOS" : "iOS"} ${meta.version} · ${
    meta.build ? `Build ${meta.build}` : "Build not available"
  }`;
}

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function contextGroupHeader(_value, count, rows) {
  const source = literalText(rows[0]?.source);
  const root = element("div", "context-group-header", source);
  const loaded = element(
    "span",
    "context-group-count",
    `${count.toLocaleString()} ${count === 1 ? "row" : "rows"} loaded`,
  );
  loaded.title =
    "Rows currently loaded for this group, not its total number of matches.";
  const contexts = [
    ...new Set(
      rows.map((row) =>
        `${row.bundle_name || "Unassigned bundle"} · ${
          row.file_name || "File not available"
        }${row.component ? ` · ${row.component}` : ""}`
      ),
    ),
  ];
  root.title = contexts.join("\n");
  root.append(loaded);
  return root;
}

export function createTranslationContext(tableElement) {
  const states = new Map();
  const expanded = new Set();
  let nextID = 0;
  let width = 0;
  let frame;
  const stateFor = (row) => {
    const id = row.getData()._row_id;
    if (!states.has(id)) {
      states.set(id, {
        open: false,
        visible: false,
        id: `translation-detail-${++nextID}`,
      });
    }
    return states.get(id);
  };
  function updateWidth() {
    const next =
      tableElement.querySelector(".tabulator-tableholder")?.clientWidth ||
      tableElement.clientWidth;
    if (!next || next === width) return;
    width = next;
    tableElement.style.setProperty("--context-width", `${width}px`);
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      for (const row of expanded) {
        if (row.getElement().isConnected) row.normalizeHeight();
      }
    });
  }
  const observer = new ResizeObserver(updateWidth);
  observer.observe(tableElement);
  updateWidth();

  function toggle(row) {
    const state = stateFor(row);
    state.open = !state.open;
    row.reformat();
    row.normalizeHeight();
    row.getElement().querySelector(".context-toggle")?.focus({
      preventScroll: true,
    });
    requestAnimationFrame(() => {
      if (row.getElement().isConnected) {
        row.getElement().querySelector(".context-toggle")?.focus({
          preventScroll: true,
        });
      }
    });
  }

  function keyFormatter(cell) {
    const row = cell.getRow(), state = stateFor(row);
    const root = element("div", "context-key-cell");
    const button = element("button", "context-toggle");
    button.type = "button";
    button.setAttribute("aria-expanded", String(state.open));
    button.setAttribute("aria-controls", state.id);
    button.setAttribute(
      "aria-label",
      state.open ? "Hide translation details" : "Show translation details",
    );
    button.title = button.getAttribute("aria-label");
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      toggle(row);
    });
    button.addEventListener("keydown", (event) => {
      event.stopPropagation();
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        toggle(row);
      }
    });
    root.append(
      button,
      element("span", "context-key-text", literalText(cell.getValue())),
    );
    return root;
  }

  function rowFormatter(row) {
    const node = row.getElement(), state = stateFor(row), data = row.getData();
    node.querySelector(":scope > .translation-detail")?.remove();
    node.classList.toggle("context-expanded", state.open);
    if (!state.open) {
      expanded.delete(row);
      return;
    }
    expanded.add(row);
    const panel = element("section", "translation-detail");
    panel.id = state.id;
    panel.setAttribute("aria-label", "Translation details");
    // Do not let Tabulator's cell-navigation shortcuts intercept controls or
    // text selection within the expanded detail panel.
    panel.addEventListener("keydown", (event) => event.stopPropagation());
    const top = element("div", "context-detail-top");
    top.append(element("div", "context-detail-title", "Translation details"));
    const label = element("label", "context-visibility");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = state.visible;
    label.title =
      "Show spaces (·), tabs (→), and line endings (␍, ↵). Copy always preserves the original text.";
    label.append(
      checkbox,
      document.createTextNode("Show invisibles"),
    );
    top.append(label);
    const fields = element("div", "context-texts");
    const values = [];
    const copyStatus = element("div", "context-copy-status");
    copyStatus.setAttribute("role", "status");
    copyStatus.hidden = true;
    for (
      const [title, raw] of [["Key", literalText(data.source)], [
        "Localization",
        literalText(data.target),
      ]]
    ) {
      const field = element("div", "context-text-field");
      const heading = element("div", "context-text-heading", title);
      const copy = element("button", "context-copy");
      copy.type = "button";
      copy.setAttribute("aria-label", `Copy ${title}`);
      const setCopyIcon = (copied) => {
        const symbol = icon(copied ? faCheck : faCopy).node[0];
        copy.replaceChildren(symbol);
        copy.title = copied ? "Copied" : `Copy ${title}`;
      };
      setCopyIcon(false);
      let copyTimer;
      copy.addEventListener("click", async (event) => {
        // Replacing the clicked SVG can detach event.target before Tabulator's
        // row handler runs. A copy action must never toggle the detail panel.
        event.stopPropagation();
        try {
          await navigator.clipboard.writeText(raw);
          copyStatus.hidden = true;
          clearTimeout(copyTimer);
          setCopyIcon(true);
          copyTimer = setTimeout(() => setCopyIcon(false), 1500);
        } catch {
          copyStatus.textContent =
            "Copy unavailable. Select the text and copy it manually.";
          copyStatus.hidden = false;
          row.normalizeHeight();
        }
      });
      const value = element(
        "pre",
        "context-value",
        state.visible ? visibleCharacters(raw) : raw,
      );
      if (title !== "Key" && data.language) value.lang = data.language;
      values.push([value, raw]);
      heading.append(copy);
      field.append(heading, value);
      fields.append(field);
    }
    checkbox.addEventListener("change", () => {
      state.visible = checkbox.checked;
      for (const [value, raw] of values) {
        value.textContent = state.visible ? visibleCharacters(raw) : raw;
      }
      row.normalizeHeight();
    });
    const provenance = data.provenance ?? {};
    const metadata = element("dl", "context-metadata");
    for (
      const [title, value] of [
        ["OS", releaseLabel(data._release)],
        ["Component", data.component || "Not available"],
        ["Locale", data.language || "Not available"],
        [
          "Bundle",
          provenance.bundle_path ??
            (data.provenance ? "Unassigned" : "Not available"),
        ],
        ["Resource", provenance.image_path || "Not available"],
      ]
    ) {
      metadata.append(
        element("dt", "", title),
        element(
          "dd",
          ["Bundle", "Resource"].includes(title) ? "context-path" : "",
          value,
        ),
      );
    }
    panel.append(top, fields, copyStatus, metadata);
    node.append(panel);
  }

  return {
    keyFormatter,
    rowFormatter,
    rowClick(event, row) {
      if (
        event.target.closest("a,button,input,label,.translation-detail") ||
        window.getSelection()?.toString()
      ) return;
      toggle(row);
    },
    destroy() {
      observer.disconnect();
      cancelAnimationFrame(frame);
      states.clear();
      expanded.clear();
    },
  };
}
