"use strict";

import { TabulatorFull as Tabulator } from "tabulator-tables";
import { languageCodeToName } from "./language_names.js";
import { createLanguageSelection } from "./language_selection.js";
import {
  createSearchLoader,
  searchErrorLabel,
  searchErrorMessage,
} from "./search_loader.js";
import { initBundleFilter } from "./bundle_filter.js";
import { initLanguagePresets } from "./language_presets.js";
import { closeSearchDropdowns } from "./dropdown.js";
import {
  contextGroupHeader,
  createTranslationContext,
} from "./translation_context.js";
import {
  readSearchState,
  searchAPIURL,
  searchPageURL,
  searchParameters,
  searchStateIdentity,
} from "./search_state.js";

export function init() {
  const pathname = document.location.pathname;
  const searchParams = new URL(document.location).searchParams;
  const defaultLanguages = Array.from(
    document.querySelectorAll('input[name="language"]:checked'),
  )
    .map((input) => input.value);
  const selectedLanguages = createLanguageSelection(
    searchParams,
    document.querySelectorAll('input[name="language"]'),
  );
  let state = readSearchState(searchParams, selectedLanguages());
  let advanced = state.advanced;
  applyState(state);
  const bundleUI = initBundleFilter();
  const presetsUI = initLanguagePresets(selectedLanguages, refreshLinks);
  const bundles = Array.from(document.getElementById("bundle-select").options)
    .map((option) => option.value).filter(Boolean);
  // Preserve the random landing sample across back/forward, without changing
  // the public URL or the user's visible search conditions.
  let fallbackBundle = history.state?.localizationFallbackBundle ??
    bundles[Math.floor(Math.random() * bundles.length)] ?? "";
  history.replaceState({
    ...history.state,
    localizationFallbackBundle: fallbackBundle,
  }, "");
  let activeURL = searchAPIURL(pathname, state, fallbackBundle);
  refreshLinks();

  const paginationSize = 200;
  let table;
  let loader;
  let columnWidths = new Map();
  let retry;
  let placeholder;
  let generation = 0;
  let contextUI;
  function createTable(widths = new Map(), request = true) {
    const requestGeneration = ++generation;
    contextUI = createTranslationContext(document.getElementById("table"));
    loader = createSearchLoader({
      onStatus: (status) => {
        if (requestGeneration !== generation) return;
        if (status.phase === "received") return; // Hide only after rows render.
        retry = status.retry;
        showStatus(
          status.phase,
          status.phase === "error"
            ? `${searchErrorMessage(status.error)}${
              status.page > 1
                ? " Results already loaded are still available."
                : ""
            }`
            : status.page > 1
            ? "Loading more results…"
            : "Searching…",
          {
            page: status.page,
            label: status.phase === "error"
              ? searchErrorLabel(status.error)
              : undefined,
          },
        );
      },
    });
    const currentLoader = loader;
    table = new Tabulator("#table", {
      height: tableHeight(),
      dataLoader: false,
      progressiveLoad: request ? "scroll" : false,
      index: "_row_id",
      paginationSize,
      groupBy: "group_id",
      groupHeader: contextGroupHeader,
      rowFormatter: contextUI.rowFormatter,
      columnDefaults: {
        headerSort: false,
        resizable: true,
        tooltip: true,
      },
      columns: columunDefs(
        (bundle) => searchPageURL(pathname, { ...formState(), b: bundle }),
        contextUI.keyFormatter,
      )
        .map((column) =>
          widths.has(column.field)
            ? { ...column, width: widths.get(column.field) }
            : column
        ),
      ajaxURL: request ? activeURL : undefined,
      ajaxRequestFunc: (url, _config, params) =>
        currentLoader.request(url, params)
          .catch((error) => {
            // The retired table is isolated; do not show its cancellation as an error.
            if (error.name === "AbortError") return { data: [], last_page: 0 };
            throw error;
          }),
      ajaxResponse: (url, _params, response) => {
        // IDs are local to a component in the new dataset. Do not overwrite rows
        // during progressive loading or merge contexts from different components.
        response.data = response.data.map((row) => ({
          ...row,
          _release: response.meta,
          _row_id: JSON.stringify([row.component ?? "legacy", row.id]),
          group_id: row.component
            ? JSON.stringify([row.component, row.group_id])
            : row.group_id,
        }));
        if (requestGeneration !== generation || url !== activeURL) {
          return response;
        }
        const f = new Intl.NumberFormat();
        const total = response.total;
        const lastPage = response.last_page || table.getPageMax();
        const totalCount = total !== undefined
          ? total
          : table.getPageSize() * lastPage;
        const text = `${f.format(totalCount)}`;
        document.getElementById("total-count").textContent = text;
        return response;
      },
      placeholder: () => {
        // Match Tabulator's markup for the original string placeholder so its
        // default empty-result typography still applies to dynamic messages.
        placeholder = document.createElement("div");
        placeholder.className = "tabulator-placeholder-contents";
        placeholder.textContent = !request
          ? "Enter a value for Advanced Search."
          : document.getElementById("search-status").dataset.phase === "idle"
          ? "No Results Found"
          : "";
        return placeholder;
      },
    });
    table.on("rowClick", contextUI.rowClick);

    table.on("dataProcessed", () => {
      if (requestGeneration !== generation) return;
      retry = undefined;
      showStatus("idle", "");

      const dataCount = table.getDataCount();
      if (dataCount !== undefined) {
        const f = new Intl.NumberFormat();
        const textContent = `${f.format(dataCount)} /`;
        document.getElementById("data-count").textContent = textContent;
        document.getElementById("search-counts").title = document
          .getElementById(
            "search-counts",
          ).textContent.replace(/\s+/g, " ").trim();
      }
    });
  }
  load();
  document.getElementById("search-retry").addEventListener("click", () => {
    const action = retry;
    retry = undefined;
    document.getElementById("search-retry").hidden = true;
    action?.();
  });

  document.getElementById("search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    search(event.submitter);
    return false;
  });
  window.addEventListener("popstate", () => {
    selectedLanguages.restore(new URL(location.href).searchParams);
    state = readSearchState(
      new URL(location.href).searchParams,
      selectedLanguages(),
    );
    fallbackBundle = history.state?.localizationFallbackBundle ??
      fallbackBundle;
    applyState(state);
    refreshLinks();
    load();
  });
  document.getElementById("header").addEventListener("input", refreshLinks);
  document.getElementById("header").addEventListener("change", refreshLinks);
  document.getElementById("sa-search-field").addEventListener("input", () => {
    if (document.getElementById("sa-search-field").value) clearAdvancedError();
  });
  document.getElementById("search-field").addEventListener("focus", () => {
    advanced = false;
    refreshLinks();
  });
  document.getElementById("sa-search-field").addEventListener("focus", () => {
    advanced = true;
    refreshLinks();
  });
  // Route Enter explicitly; changing button type/disabled on blur causes a
  // disabled-button pointer gesture to become a submit midway through it.
  for (
    const [field, button] of [["search-field", "search-button"], [
      "sa-search-field",
      "sa-search-button",
    ]]
  ) {
    document.getElementById(field).addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.isComposing) return;
      event.preventDefault();
      document.getElementById("search-form").requestSubmit(
        document.getElementById(button),
      );
    });
  }

  function search(submitter) {
    if (submitter?.disabled) return;
    if (submitter) {
      advanced = submitter === document.getElementById("sa-search-button");
    }
    const proposed = formState();
    // Empty advanced queries are rejected by the API. Keep the current URL,
    // results and in-flight search unchanged until the user provides a value.
    if (proposed.advanced && !proposed.q) {
      showAdvancedError();
      return;
    }
    clearAdvancedError();
    bundleUI.close();
    closeSearchDropdowns();
    state = proposed;
    const next = searchPageURL(pathname, state);
    const current = readSearchState(
      new URL(location.href).searchParams,
      defaultLanguages,
    );
    if (searchStateIdentity(state) !== searchStateIdentity(current)) {
      history.pushState(
        { localizationFallbackBundle: fallbackBundle },
        "",
        next,
      );
    }
    applyState(state);
    refreshLinks();
    load();
  }

  function load() {
    activeURL = searchAPIURL(pathname, state, fallbackBundle);
    ++generation;
    loader?.cancel();
    contextUI?.destroy();
    retry = undefined;
    placeholder = undefined;
    document.getElementById("data-count").textContent = "";
    document.getElementById("total-count").textContent = "";
    // Progressive loading appends rows before Tabulator's stale-request check.
    // Retire that loader completely on a new search/history navigation. Its
    // late responses cannot touch the new rows, paging state or counters.
    if (table) {
      columnWidths = new Map(
        table.getColumns().map((c) => [c.getField(), c.getWidth()]),
      );
      table.destroy();
      table = undefined;
    }
    // Also isolate any late error/loader DOM updates from the retired instance.
    const element = document.getElementById("table");
    element.replaceWith(element.cloneNode(false));
    document.getElementById("table").hidden = false;
    const missingAdvancedValue = state.advanced && !state.q;
    showStatus(
      missingAdvancedValue ? "idle" : "loading",
      missingAdvancedValue ? "" : "Searching…",
    );
    createTable(columnWidths, !missingAdvancedValue);
    if (missingAdvancedValue) showAdvancedError();
  }

  function clearAdvancedError() {
    document.getElementById("sa-search-error").hidden = true;
    document.getElementById("sa-search-field").removeAttribute("aria-invalid");
  }

  function showAdvancedError() {
    bundleUI.close();
    const trigger = document.getElementById("advanced-trigger");
    if (trigger.getAttribute("aria-expanded") !== "true") trigger.click();
    const input = document.getElementById("sa-search-field");
    input.setAttribute("aria-invalid", "true");
    document.getElementById("sa-search-error").hidden = false;
    input.focus();
  }

  function formState() {
    return {
      advanced,
      q: document.getElementById(advanced ? "sa-search-field" : "search-field")
        .value,
      b: document.getElementById("bundle-select").value,
      c: advanced ? document.getElementById("sa-column").value : "",
      o: advanced ? document.getElementById("sa-operator").value : "",
      languages: selectedLanguages(),
      locales: selectedLanguages.locales(),
    };
  }

  function applyState(next) {
    clearAdvancedError();
    advanced = next.advanced;
    document.getElementById("search-field").value = advanced ? "" : next.q;
    document.getElementById("sa-search-field").value = advanced ? next.q : "";
    document.getElementById("sa-column").value = next.c || "key";
    document.getElementById("sa-operator").value = next.o || "equal";
    const select = document.getElementById("bundle-select");
    // Preserve a bundle absent from another OS's catalog: show zero results,
    // never silently broaden that URL into an unfiltered search.
    for (const option of select.querySelectorAll("[data-url-bundle]")) {
      option.remove();
    }
    if (next.b && !Array.from(select.options).some((o) => o.value === next.b)) {
      const option = new Option(next.b, next.b);
      option.dataset.urlBundle = "true";
      select.add(option);
    }
    select.value = next.b;
    selectedLanguages.restore(searchParameters(next));
  }

  function refreshLinks() {
    bundleUI.sync();
    presetsUI.sync();
    const advancedTrigger = document.getElementById("advanced-trigger");
    advancedTrigger.classList.toggle("is-info", state.advanced);
    advancedTrigger.title = state.advanced
      ? "Advanced Search (active)"
      : "Advanced Search";
    advancedTrigger.setAttribute("aria-label", advancedTrigger.title);
    const current = formState();
    for (const link of document.querySelectorAll("a[data-search-path]")) {
      link.href = searchPageURL(link.dataset.searchPath, current);
    }
    for (const link of document.querySelectorAll("a[data-search-bundle]")) {
      link.href = searchPageURL(pathname, {
        ...current,
        b: link.dataset.searchBundle,
      });
    }
  }

  function showStatus(phase, message, { page = 1, label = message } = {}) {
    const status = document.getElementById("search-status");
    status.hidden = !message;
    status.dataset.phase = phase;
    const statusMessage = document.getElementById("search-status-message");
    statusMessage.textContent = label;
    statusMessage.setAttribute("aria-label", message);
    statusMessage.title = message;
    // Additional pages need only a spinner beside the existing counts, while
    // assistive technology still receives the full loading announcement.
    statusMessage.classList.toggle(
      "is-sr-only",
      phase === "loading" && page > 1,
    );
    document.getElementById("search-counts").hidden = !document.getElementById(
      "total-count",
    ).textContent;
    document.getElementById("search-retry").hidden = !retry;
    if (placeholder) {
      placeholder.textContent = state.advanced && !state.q
        ? "Enter a value for Advanced Search."
        : phase === "idle"
        ? "No Results Found"
        : "";
    }
  }
}

function columunDefs(bundleURL, keyFormatter) {
  return [
    {
      title: "Key",
      field: "source",
      width: "34vw",
      frozen: true,
      formatter: keyFormatter,
    },
    {
      title: "Localization",
      field: "target",
      width: "38vw",
      formatter: (cell, _formatterParams, _onRendered) => {
        const value = cell.getValue();
        const lang = cell.getData().language;
        return `<span lang="${escapeHtml(String(lang))}">${
          escapeHtml(value)
        }</span>`;
      },
    },
    {
      title: "Language",
      field: "language",
      minWidth: 84,
      formatter: (cell, _formatterParams, _onRendered) => {
        const value = cell.getValue();
        return languageCodeToName(value);
      },
      tooltip: (_event, cell, _onRender) => {
        const value = cell.getValue();
        return languageCodeToName(value);
      },
    },
    {
      title: "Locale",
      field: "language",
      minWidth: 84,
    },
    {
      title: "Bundle",
      field: "bundle_name",
      minWidth: 150,
      formatter: (cell) => {
        const link = document.createElement("a");
        const bundle = String(cell.getValue());
        link.textContent = bundle;
        link.dataset.searchBundle = bundle;
        link.href = bundleURL(bundle);
        return link;
      },
    },
    {
      title: "File",
      field: "file_name",
      minWidth: 138,
    },
    {
      title: "#",
      field: "id",
      minWidth: 54,
      formatter: "rownum",
      hozAlign: "right",
      tooltip: (_event, cell, _onRender) => {
        return cell.getRow().getPosition();
      },
    },
  ];
}

function tableHeight() {
  const viewport = CSS.supports("height", "100svh") ? "100svh" : "100vh";
  const headerHeight = document.getElementById("header").offsetHeight;
  return `calc(${viewport} - ${headerHeight}px - 1.5rem - 0.75rem)`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}
