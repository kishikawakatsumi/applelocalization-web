"use strict";

export function setupDropdownTrigger() {
  const trigger = document.getElementById("dropdown-filter-trigger");
  const dropdownFilter = document.getElementById("dropdown-filter");

  const dropdownPlatform = document.getElementById("dropdown-platform");
  const bundleSelect = document.getElementById("bundle-select");

  trigger.addEventListener("click", function (e) {
    e.stopPropagation();
    dropdownFilter.classList.toggle("is-active");
  });
  dropdownFilter.addEventListener("click", function (e) {
    e.stopPropagation();
  });

  dropdownPlatform.addEventListener("mouseover", function (e) {
    dropdownFilter.classList.remove("is-active");
  });
  bundleSelect.addEventListener("focus", function (e) {
    dropdownFilter.classList.remove("is-active");
  });

  document.addEventListener("click", function (e) {
    if (e.currentTarget === trigger) {
      return;
    }
    dropdownFilter.classList.remove("is-active");
  });
}
