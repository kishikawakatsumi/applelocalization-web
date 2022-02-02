"use strict";

const pathname = document.location.pathname;
const platform = pathname === "/macos" ? "macos" : "ios";

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
  height: "84vh",
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
  ajaxResponse: function (url, _params, response) {
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
      history.replaceState(null, "", platform === "macos" ? "/macos" : "/");
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
        loading: `<span class="fad fa-spinner-third fa-spin fa-fw"></span><span class="p-2">Loading ...</span>`,
        error: "Error",
      },
    },
  },
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

function search() {
  table.setData(buildQuery());
}
window.search = search;

function buildQuery() {
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

  if (saSearchWord.trim()) {
    const endpoint = `/api/${platform}/search/advanced`;
    const query = `?c=${column.trim()}&o=${operator}&q=${saSearchWord.trim()}${languageFilter}`;
    return `${endpoint}${query}`;
  } else {
    const endpoint = `/api/${platform}/search`;
    const query = `?q=${searchWord.trim()}&b=${bundle.trim()}${languageFilter}`;
    return `${endpoint}${query}`;
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
    },
    {
      title: "Language",
      field: "language",
      minWidth: 84,
      formatter: (cell, _formatterParams, _onRendered) => {
        const value = cell.getValue();
        return languageCodeToName(value);
      },
      tooltip: (cell) => {
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

function languageCodeToName(code) {
  const map = {
    Base: "English",
    English: "English",
    en: "English (United States)",
    en_AU: "English (Australia)",
    en_CA: "English (Canada)",
    en_GB: "English (United Kingdom)",
    en_ID: "English (Indonesia)",
    en_IN: "English (India)",
    en_MY: "English (Malaysia)",
    en_NZ: "English (New Zealand)",
    en_SG: "English (Singapore)",
    French: "French",
    fr: "French (France)",
    fr_BE: "French (Belgium)",
    fr_CA: "French (Canada)",
    fr_CH: "French (Switzerland)",
    German: "German",
    de: "German (Germany)",
    "de-AT": "German (Austria)",
    "de-CH": "German (Switzerland)",
    Italian: "Italian",
    it: "Italian (Italy)",
    it_CH: "Italian (Switzerland)",
    Japanese: "Japanese",
    ja: "Japanese (Japan)",
    Spanish: "Spanish",
    es: "Spanish (Spain)",
    es_419: "Spanish (Latin America)",
    es_AR: "Spanish (Argentina)",
    es_CL: "Spanish (Chile)",
    es_CR: "Spanish (Costa Rica)",
    es_CO: "Spanish (Colombia)",
    es_GT: "Spanish (Guatemala)",
    es_MX: "Spanish (Mexico)",
    es_PA: "Spanish (Panama)",
    es_PE: "Spanish (Peru)",
    ar: "Arabic (Saudi Arabia)",
    ar_AE: "Arabic (United Arab Emirates)",
    ar_SA: "Arabic (Saudi Arabia)",
    ca: "Catalan (Spain)",
    cs: "Czech (Czech Republic)",
    da: "Danish (Denmark)",
    Dutch: "Dutch",
    nl: "Dutch (Netherlands)",
    el: "Greek (Greece)",
    fi: "Finnish (Finland)",
    gu_Latn: "Gujarati (India)",
    he: "Hebrew",
    hi: "Hindi (India)",
    hi_Latn: "Hindi (India)",
    hu: "Hungarian (Hungary)",
    id: "Indonesian (Indonesia)",
    kn_Latn: "Kannada (India)",
    ko: "Korean (South Korea)",
    ml_Latn: "Malayalam (India)",
    mr_Latn: "Marathi (India)",
    ms: "Malay (Malaysia)",
    no: "Norwegian (Norway)",
    or_Latn: "Oriya (India)",
    pa_Latn: "Punjabi (India)",
    pl: "Polish (Poland)",
    pt: "Portuguese (Brazil)",
    pt_BR: "Portuguese (Brazil)",
    pt_PT: "Portuguese (Portugal)",
    ro: "Romanian (Romania)",
    ru: "Russian (Russia)",
    sk: "Slovak (Slovakia)",
    sv: "Swedish (Sweden)",
    ta_Latn: "Tamil (India)",
    te_Latn: "Telugu (India)",
    th: "Thai (Thailand)",
    tr: "Turkish (Turkey)",
    uk: "Ukrainian (Ukraine)",
    vi: "Vietnamese (Vietnam)",
    zh_CN: "Chinese (China)",
    zh_HK: "Chinese (Hong Kong)",
    zh_TW: "Chinese (Taiwan)",
    yue: "Cantonese (Hong Kong)",
    "yue-CN": "Cantonese (Hong Kong)",
  };
  return map[code] || code;
}

function setLoading(loading) {
  if (loading) {
    table.dataLoader.showLoader();
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
    document.getElementById("sa-search-control").classList.remove("is-loading");
    document.getElementById("sa-search-button").classList.remove("is-loading");
  }
}
