"use strict";

import "bulma/css/bulma.min.css";
import "tabulator-tables/dist/css/tabulator_simple.min.css";

import "./css/index.css";
import "./css/table.css";

import Plausible from "plausible-tracker";
import "./js/icon.js";

import { init } from "./js/search.js";
import { setupDropdownTrigger } from "./js/dropdown";

const { enableAutoPageviews } = Plausible({
  domain: "applelocalization.com",
});
enableAutoPageviews();

new ResizeObserver(() => {
  const container = document.querySelector(".container");
  const dropdownMenu = document.getElementById("dropdown-menu-filter");

  const containerWidth = container.offsetWidth;
  dropdownMenu.style.width = `${containerWidth}px`;
}).observe(document.body);

setupDropdownTrigger();
init();
