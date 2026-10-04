"use strict";

import "bulma/css/bulma.min.css";
import "tabulator-tables/dist/css/tabulator_simple.min.css";

import "./css/index.css";
import "./css/table.css";
import "./css/bundle_filter.css";
import "./css/translation_context.css";

import "./js/icon.js";

import { init } from "./js/search.js";
import { setupDropdownTrigger } from "./js/dropdown";

setupDropdownTrigger();
init();
