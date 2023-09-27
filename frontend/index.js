"use strict";

import "bulma/css/bulma.min.css";
import "tabulator-tables/dist/css/tabulator_simple.min.css";

import "./css/index.css";
import "./css/table.css";

import Plausible from "plausible-tracker";
import "./js/icon.js";

import { Search } from "./js/search.js";

const { enableAutoPageviews } = Plausible({
  domain: "applelocalization.com",
});
enableAutoPageviews();

Search.init();
