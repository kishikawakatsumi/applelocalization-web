"use strict";

import { TabulatorFull as Tabulator } from "tabulator-tables";
import { languageCodeToName } from "./language_names.js";

export function init() {
  const pathname = document.location.pathname;
  const platform = pathname.startsWith("/macos") ? "macos" : "ios";
  const version = (() => {
    const version = pathname.split("/")[2];
    if (version) {
      return `/${version}`;
    }
    return "";
  })();

  const searchParams = new URL(document.location).searchParams;
  const columnQuery = searchParams.get("c") || "";
  if (columnQuery) {
    document.getElementById("sa-column").value = columnQuery;
  }
  const operatorQuery = searchParams.get("o") || "";
  if (operatorQuery) {
    document.getElementById("sa-operator").value = operatorQuery;
  }
  const searchQuery = searchParams.get("q") || "";
  if (searchQuery) {
    if (columnQuery || operatorQuery) {
      document.getElementById("sa-search-field").value = searchQuery;
    } else {
      document.getElementById("search-field").value = searchQuery;
    }
  }
  const bundleQuery = searchParams.get("b") || "";
  if (bundleQuery) {
    document.getElementById("bundle-select").value = bundleQuery;
  }
  const languageQuery = searchParams.getAll("l") || [];
  if (languageQuery) {
    for (const language of languageQuery) {
      for (const checkbox of Array.from(
        document.querySelectorAll('input[name="language"]')
      )) {
        if (checkbox.value === language) {
          checkbox.checked = true;
        }
      }
    }
  }

  const paginationSize = 200;
  const table = new Tabulator("#table", {
    height: tableHeight(),
    progressiveLoad: "scroll",
    paginationSize,
    groupBy: "group_id",
    groupHeader: (_value, count, data, _group) => {
      return `${data[0].source}<span style="margin-left: 10px;">(${count} item)</span>`;
    },
    columnDefaults: {
      headerSort: false,
      resizable: true,
      tooltip: true,
    },
    columns: columunDefs(),
    ajaxURL: buildQuery(),
    ajaxResponse: (url, _params, response) => {
      const currentLocation = new URL(`${document.location.origin}${url}`);
      const searchParams = currentLocation.searchParams;
      if (!document.getElementById("bundle-select").value) {
        searchParams.delete("b");
      }
      if (
        !document.getElementById("search-field").value &&
        !document.getElementById("bundle-select").value &&
        !document.getElementById("sa-search-field").value
      ) {
        history.replaceState(
          null,
          "",
          platform === "macos"
            ? `/macos${version}`
            : version
            ? `/ios${version}`
            : "/"
        );
      } else {
        history.pushState(null, "", currentLocation.search);
      }

      const f = new Intl.NumberFormat();
      const total = response.total;
      const lastPage = response.last_page || table.getPageMax();
      const totalCount =
        total !== undefined ? total : table.getPageSize() * lastPage;
      const text = `${f.format(totalCount)}`;
      document.getElementById("total-count").textContent = text;
      return response;
    },
    langs: {
      default: {
        data: {
          loading: `<span class="fa-duotone fa-spinner-third fa-spin fa-fw"></span><span class="p-2">Loading ...</span>`,
          error: "Error",
        },
      },
    },
    placeholder: "No Results Found",
  });

  table.on("dataLoading", (_data) => {
    setLoading(true);
  });

  table.on("dataProcessed", () => {
    setLoading(false);

    const dataCount = table.getDataCount();
    if (dataCount !== undefined) {
      const f = new Intl.NumberFormat();
      const textContent = `${f.format(dataCount)} /`;
      document.getElementById("data-count").textContent = textContent;
    }
  });

  table.on("dataLoadError", (_error) => {
    setLoading(false);
  });

  document.getElementById("search-form").addEventListener("submit", (event) => {
    event.preventDefault();
    search(event.submitter);
    return false;
  });
  document.getElementById("search-field").addEventListener("focus", () => {
    const button = document.getElementById("sa-search-button");
    button.setAttribute("type", "button");
    button.setAttribute("disabled", true);
  });
  document.getElementById("search-field").addEventListener("blur", () => {
    const button = document.getElementById("sa-search-button");
    button.setAttribute("type", "submit");
    button.removeAttribute("disabled");
  });
  document.getElementById("sa-search-field").addEventListener("focus", () => {
    const button = document.getElementById("search-button");
    button.setAttribute("type", "button");
    button.setAttribute("disabled", true);
  });
  document.getElementById("sa-search-field").addEventListener("blur", () => {
    const button = document.getElementById("search-button");
    button.setAttribute("type", "submit");
    button.removeAttribute("disabled");
  });

  function search(submitter) {
    table.setData(buildQuery(submitter));
  }

  function buildQuery(submitter) {
    const searchWord = document.getElementById("search-field").value || "";
    const bundle = (() => {
      const bundle = document.getElementById("bundle-select").value || "";
      if (!bundle && !searchWord) {
        const bundles = Array.from(
          document.getElementById("bundle-select").options
        )
          .map((option) => option.value)
          .filter((option) => option);
        return bundles[Math.floor(Math.random() * bundles.length)];
      }
      return bundle;
    })();

    const languageFilter = Array.from(
      document.querySelectorAll('input[name="language"]:checked')
    )
      .map((el) => {
        return `&l=${el.value.trim()}`;
      })
      .join("");

    const column = document.getElementById("sa-column").value || "";
    const operator = document.getElementById("sa-operator").value || "";
    const saSearchWord = document.getElementById("sa-search-field").value || "";

    if (
      saSearchWord.trim() &&
      submitter === document.getElementById("sa-search-button")
    ) {
      const endpoint = `/api/${platform}${version}/search/advanced`;
      const query = `?c=${column.trim()}&o=${operator}&q=${saSearchWord.trim()}${languageFilter}`;
      return `${endpoint}${query}`;
    } else {
      const endpoint = `/api/${platform}${version}/search`;
      const query = `?q=${searchWord.trim()}&b=${bundle.trim()}${languageFilter}`;
      return `${endpoint}${query}`;
    }
  }

  function setLoading(loading) {
    if (loading) {
      table.dataLoader.alertLoader();

      document.getElementById("search-field").setAttribute("disabled", true);
      document.getElementById("search-control").classList.add("is-loading");
      document.getElementById("search-button").classList.add("is-loading");
      document.getElementById("sa-search-field").setAttribute("disabled", true);
      document.getElementById("sa-search-control").classList.add("is-loading");
      document.getElementById("sa-search-button").classList.add("is-loading");
    } else {
      document.getElementById("search-field").removeAttribute("disabled");
      document.getElementById("search-control").classList.remove("is-loading");
      document.getElementById("search-button").classList.remove("is-loading");
      document.getElementById("sa-search-field").removeAttribute("disabled");
      document
        .getElementById("sa-search-control")
        .classList.remove("is-loading");
      document
        .getElementById("sa-search-button")
        .classList.remove("is-loading");
    }
  }
}

function columunDefs() {
  return [
    {
      title: "Key",
      field: "source",
      width: "34vw",
      frozen: true,
    },
    {
      title: "Localization",
      field: "target",
      width: "38vw",
      formatter: (cell, _formatterParams, _onRendered) => {
        const value = cell.getValue();
        const lang = cell.getData().language;
        return `<span lang="${lang}">${escapeHtml(value)}</span>`;
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
      formatter: "link",
      formatterParams: {
        labelField: "bundle_name",
        urlField: "bundle_name",
        urlPrefix: "?b=",
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
