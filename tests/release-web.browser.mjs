import test from "node:test";
import assert from "node:assert/strict";
import { localBrowser } from "./helpers/local-browser.mjs";

test(
  "review UI: fulltext finds stringsdict translation and preserves JSON details",
  { skip: process.env.ALLOW_RELEASE_REVIEW_TEST !== "1", timeout: 90000 },
  async (t) => {
    const params = new URLSearchParams({
      q: "入手可能なアップデートはありません",
      b: "App Store.app",
    });
    params.append("l", "English");
    params.append("l", "Japanese");
    const response = await fetch(
      "http://127.0.0.1:8084/api/macos/26/search?" + params,
      { signal: AbortSignal.timeout(60000) },
    );
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.meta.dataset, "macos26");
    const japanese = payload.data.find((r) =>
      r.source === "UPDATES_AVAILABLE_COUNT" && r.language === "ja"
    );
    assert.ok(japanese, "JSON-internal Japanese text must find its resource");
    assert.equal(japanese.target_kind, "structured");
    assert.equal(japanese.file_name, "Accessibility.stringsdict");
    assert.equal(
      japanese.target_value.update_count.zero,
      "入手可能なアップデートはありません",
    );
    assert.deepEqual(JSON.parse(japanese.target), japanese.target_value);
    assert.ok(
      payload.data.some((r) =>
        r.source === "UPDATES_AVAILABLE_COUNT" && r.language === "en"
      ),
      "selected English context remains available",
    );
    assert.ok(payload.data.every((r) => r.bundle_name === "App Store.app"));
    const b = await localBrowser(t);
    await b.viewport(1440, 1000);
    await b.rawNavigate("http://127.0.0.1:8084/macos/26?" + params);
    await b.until(
      "document.getElementById('search-status')?.dataset.phase==='idle' && document.querySelector('.context-toggle')",
    );
    await b.mouseClick(".context-toggle");
    assert.equal(
      await b.evaluate(
        "document.querySelector('.context-text-field:last-child .context-text-heading').textContent",
      ),
      "Localization",
    );
    assert.equal(
      await b.evaluate(
        "document.querySelector('.context-text-field:last-child .context-value').textContent",
      ),
      payload.data[0].target,
    );
    console.log("screenshot", await b.screenshot("structured-fulltext-result"));
  },
);

test(
  "review UI: translation details match real API provenance and release metadata",
  { skip: process.env.ALLOW_RELEASE_REVIEW_TEST !== "1", timeout: 90000 },
  async (t) => {
    const b = await localBrowser(t);
    await b.viewport(1440, 1000);
    const params = "c=key&o=equal&q=Open&l=Japanese&l=English";
    const response = await fetch(
      "http://127.0.0.1:8084/api/macos/26/search/advanced?" + params,
    );
    assert.equal(response.status, 200);
    const payload = await response.json(), first = payload.data[0];
    await b.rawNavigate("http://127.0.0.1:8084/macos/26?" + params);
    await b.until(
      "document.getElementById('search-status')?.dataset.phase==='idle' && document.querySelector('.context-toggle')",
    );
    await b.mouseClick(".context-toggle");
    await b.until("document.querySelector('.translation-detail') !== null");
    assert.deepEqual(
      await b.evaluate(
        "Array.from(document.querySelectorAll('.translation-detail .context-value')).map(e=>e.textContent)",
      ),
      [first.source, first.target],
    );
    assert.deepEqual(
      await b.evaluate(
        "Array.from(document.querySelectorAll('.translation-detail .context-metadata dd')).map(e=>e.textContent)",
      ),
      [
        `macOS ${payload.meta.version} · Build ${payload.meta.build}`,
        first.component,
        first.language,
        first.provenance.bundle_path ?? "Unassigned",
        first.provenance.image_path,
      ],
    );
    const group = await b.evaluate(
      "document.querySelector('.context-group-header').title",
    );
    assert.ok(group.includes(first.bundle_name));
    assert.ok(group.includes(first.file_name));
    assert.equal(
      await b.evaluate(
        "document.querySelector('.tabulator-group').offsetHeight <= 30 && !document.querySelector('.context-group-source')",
      ),
      true,
    );
    assert.equal(
      await b.evaluate(
        "document.querySelector('.context-visibility').textContent",
      ),
      "Show invisibles",
    );
    await b.until(
      "document.querySelectorAll('.context-copy svg[data-icon=copy]').length === 2",
    );
    assert.equal(
      await b.evaluate(
        "Array.from(document.querySelectorAll('.context-copy')).every(e=>e.textContent==='' && e.title.startsWith('Copy ') && e.getAttribute('aria-label').startsWith('Copy '))",
      ),
      true,
    );
    assert.match(
      await b.evaluate(
        "document.querySelector('.context-group-count').textContent",
      ),
      /rows? loaded/,
    );
    for (const width of [1024, 1440]) {
      await b.viewport(width, 1000);
      await b.until(`(() => {
        const panel = document.querySelector('.translation-detail').getBoundingClientRect();
        const holder = document.querySelector('.tabulator-tableholder').getBoundingClientRect();
        return panel.width > 500 && panel.left >= holder.left && panel.right <= holder.right + 1;
      })()`);
    }
    // Horizontal scrolling leaves the full-width detail readable, while the
    // original result columns and links remain available.
    await b.evaluate(
      "document.querySelector('.tabulator-tableholder').scrollLeft=150",
    );
    await b.until(
      "document.querySelector('.translation-detail').getBoundingClientRect().left >= 31",
    );
    await b.evaluate(
      "document.querySelector('.tabulator-tableholder').scrollLeft=0",
    );
    console.log("screenshot", await b.screenshot("real-translation-context"));
    await b.mouseClick(".context-toggle");
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('.translation-detail').length",
      ),
      0,
    );
    await b.mouseClick(
      ".tabulator-row:not(.tabulator-group) .tabulator-cell[tabulator-field=target]",
    );
    await b.until("document.querySelector('.translation-detail') !== null");
  },
);

test(
  "review UI: matching arrow colors and legacy empty-result appearance",
  { skip: process.env.ALLOW_RELEASE_REVIEW_TEST !== "1", timeout: 60000 },
  async (t) => {
    const b = await localBrowser(t);
    await b.viewport(1440, 1000);
    await b.rawNavigate(
      "http://127.0.0.1:8084/macos/26?c=key&o=equal&q=__ui_empty_result_regression_20261004__&l=Japanese",
    );
    await b.until(
      "document.getElementById('search-status')?.dataset.phase === 'idle' && document.getElementById('total-count').textContent === '0'",
    );
    await b.until(
      "document.querySelector('#bundle-trigger svg[data-icon=angle-down]') && document.querySelector('#dropdown-filter-trigger svg[data-icon=angle-down]')",
    );
    assert.equal(
      await b.evaluate(
        "getComputedStyle(document.querySelector('#bundle-trigger svg[data-icon=angle-down]')).color",
      ),
      await b.evaluate(
        "getComputedStyle(document.querySelector('#dropdown-filter-trigger svg[data-icon=angle-down]')).color",
      ),
    );
    assert.deepEqual(
      await b.evaluate(`(() => {
      const node = document.querySelector('.tabulator-placeholder-contents');
      if (!node) return null;
      const style = getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      const holder = document.querySelector('.tabulator-tableholder').getBoundingClientRect();
      return {text:node.textContent, color:style.color, size:style.fontSize,
        weight:style.fontWeight, align:style.textAlign,
        centered:Math.abs((rect.left+rect.right-holder.left-holder.right)/2)<2 &&
          Math.abs((rect.top+rect.bottom-holder.top-holder.bottom)/2)<2};
    })()`),
      {
        text: "No Results Found",
        color: "rgb(204, 204, 204)",
        size: "20px",
        weight: "700",
        align: "center",
        centered: true,
      },
    );
    console.log(
      "screenshot",
      await b.screenshot("legacy-empty-results-arrow-color"),
    );
  },
);

test(
  "review UI: preset input then change applies saved and built-in languages",
  { skip: process.env.ALLOW_RELEASE_REVIEW_TEST !== "1", timeout: 60000 },
  async (t) => {
    // localBrowser uses an isolated profile: never modify the user's presets.
    const b = await localBrowser(t);
    await b.viewport(1440, 1000);
    const url =
      "http://127.0.0.1:8084/macos/26?c=key&o=equal&q=Open&l=Japanese";
    await b.rawNavigate(url);
    await b.until(
      "document.getElementById('search-status').dataset.phase === 'idle'",
    );
    await b.until(
      "document.querySelector('#bundle-trigger svg[data-icon=angle-down]')",
    );
    assert.equal(
      await b.evaluate(`(() => {
      const button = document.getElementById('bundle-trigger').getBoundingClientRect();
      const arrow = document.querySelector('#bundle-trigger svg[data-icon=angle-down]').getBoundingClientRect();
      return arrow.width > 0 && arrow.height > 0 && arrow.left > button.left + button.width / 2
        && arrow.right <= button.right && arrow.top >= button.top && arrow.bottom <= button.bottom;
    })()`),
      true,
      "bundle arrow is visible inside the right side of its button",
    );
    assert.equal(
      await b.evaluate(
        "document.getElementById('bundle-trigger').textContent.includes('⌄')",
      ),
      false,
    );
    await b.mouseClick("#dropdown-filter-trigger");
    assert.deepEqual(
      await b.evaluate(`(() => {
      const select = document.getElementById('language-presets');
      return {value:select.value, text:select.options[0].text,
        label:select.getAttribute('aria-label')};
    })()`),
      { value: "", text: "", label: "Language presets" },
    );
    await b.evaluate(
      "document.getElementById('preset-name').value='Japanese only'",
    );
    await b.mouseClick("#preset-save");
    assert.equal(
      await b.evaluate("document.getElementById('preset-notice').hidden"),
      true,
    );
    for (
      const [value, languages] of [
        ["default:en-ja", ["English", "Japanese"]],
        ["saved:Japanese only", ["Japanese"]],
      ]
    ) {
      await b.evaluate(
        `document.getElementById('language-presets').value=${
          JSON.stringify(value)
        };
        document.getElementById('language-presets').dispatchEvent(new Event('input',{bubbles:true}))`,
      );
      assert.equal(
        await b.evaluate("document.getElementById('language-presets').value"),
        value,
      );
      await b.evaluate(
        "document.getElementById('language-presets').dispatchEvent(new Event('change',{bubbles:true}))",
      );
      assert.deepEqual(
        await b.evaluate(
          "Array.from(document.querySelectorAll('input[name=language]:checked')).map(e=>e.value)",
        ),
        languages,
      );
      assert.equal(
        await b.evaluate("location.href"),
        url,
        "loading a preset does not run a search",
      );
      assert.equal(
        await b.evaluate(
          "document.getElementById('dropdown-filter-trigger').getAttribute('aria-expanded')",
        ),
        "true",
      );
    }
    assert.equal(
      await b.evaluate("document.getElementById('preset-notice').hidden"),
      true,
    );
    assert.equal(
      await b.evaluate("document.getElementById('preset-delete').disabled"),
      false,
    );
    // Errors remain visible; successful deletion clears that error without a
    // replacement success notice and leaves the current languages unchanged.
    await b.evaluate(
      "document.getElementById('preset-name').value='Japanese only'",
    );
    await b.mouseClick("#preset-save");
    assert.equal(
      await b.evaluate("document.getElementById('preset-notice').hidden"),
      false,
    );
    assert.match(
      await b.evaluate("document.getElementById('preset-notice').textContent"),
      /already saved/,
    );
    await b.mouseClick("#preset-delete");
    assert.equal(
      await b.evaluate(
        "document.getElementById('language-presets').selectedOptions[0].text",
      ),
      "",
    );
    assert.equal(
      await b.evaluate("document.getElementById('preset-notice').hidden"),
      true,
    );
    assert.equal(
      await b.evaluate(
        "Array.from(document.getElementById('language-presets').options).some(o=>o.value==='saved:Japanese only')",
      ),
      false,
    );
    console.log(
      "screenshot",
      await b.screenshot("preset-errors-only-bundle-icon"),
    );
  },
);

test(
  "existing UI against unified Compose: versions, paging, languages, advanced URL",
  {
    skip: process.env.ALLOW_RELEASE_REVIEW_TEST !== "1",
    timeout: 180000,
  },
  async (t) => {
    const b = await localBrowser(t);
    await b.viewport(1440, 1000);
    const base = "http://127.0.0.1:8084";
    const ready =
      "document.querySelectorAll('.tabulator-row:not(.tabulator-group)').length > 0 && document.getElementById('search-status').dataset.phase === 'idle'";
    await b.rawNavigate(
      base + "/ios/27?q=" + encodeURIComponent("設定") +
        "&l=Japanese&l=English",
    );
    await b.until(ready);
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('#dropdown-menu-platform a').length",
      ),
      12,
    );
    assert.ok(
      await b.evaluate(
        "Array.from(document.querySelectorAll('input[name=language]')).every(e=>!['en-AU','da-DK','da~mac','en_PH~mac'].includes(e.value))",
      ),
    );
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('input[name=language][value=English]').length",
      ),
      1,
    );
    assert.deepEqual(
      await b.evaluate(
        "Array.from(document.querySelectorAll('input[name=language]:checked')).map(e=>e.value).sort()",
      ),
      ["English", "Japanese"],
    );
    assert.match(
      await b.evaluate("document.getElementById('total-count').textContent"),
      /[1-9]/,
    );
    assert.equal(
      await b.evaluate("document.querySelectorAll('.tabulator-col').length"),
      7,
    );
    await b.evaluate(
      "const holder=document.querySelector('.tabulator-tableholder');holder.scrollTop=holder.scrollHeight;holder.dispatchEvent(new Event('scroll'))",
    );
    await b.until(
      "parseInt(document.getElementById('data-count').textContent.replaceAll(',','')) > 200",
    );
    console.log("screenshot", await b.screenshot("existing-ui-ios27"));
    const bundle = await b.evaluate(
      "document.querySelector('.tabulator-row .tabulator-cell[tabulator-field=bundle_name]').textContent",
    );
    await b.evaluate(
      `document.getElementById('bundle-select').value=${
        JSON.stringify(bundle)
      };document.getElementById('search-field').value='';for(const e of document.querySelectorAll('input[name=language]')){e.checked=e.value==='Japanese';e.dispatchEvent(new Event('change'));}document.getElementById('search-form').requestSubmit(document.getElementById('search-button'))`,
    );
    await b.until(
      ready +
        " && new URL(location.href).searchParams.getAll('l').join(',')==='Japanese'",
    );
    assert.ok(
      await b.evaluate(
        `Array.from(document.querySelectorAll('.tabulator-row .tabulator-cell[tabulator-field=bundle_name]')).every(e=>e.textContent===${
          JSON.stringify(bundle)
        })`,
      ),
    );
    assert.ok(
      await b.evaluate(
        "document.querySelectorAll('.tabulator-row:not(.tabulator-group)').length > 0",
      ),
    );
    await b.rawNavigate(
      base + "/macos/26?c=key&o=equal&q=Open&l=Japanese&l=English",
    );
    await b.until("location.pathname === '/macos/26' && " + ready);
    assert.ok(
      await b.evaluate(
        "performance.getEntriesByType('resource').some(e => e.name.includes('/api/macos/26/search/advanced?'))",
      ),
    );
    assert.equal(
      await b.evaluate("document.getElementById('sa-search-field').value"),
      "Open",
    );
    assert.ok(
      await b.evaluate(
        "Array.from(document.querySelectorAll('.tabulator-row .tabulator-cell[tabulator-field=source]')).every(e=>e.textContent==='Open')",
      ),
    );
    console.log("screenshot", await b.screenshot("existing-ui-macos26"));
    await b.evaluate("document.getElementById('bundle-trigger').click()");
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('#bundle-options button').length === document.getElementById('bundle-select').options.length",
      ),
      true,
    );
    assert.ok(
      await b.evaluate(
        "document.getElementById('bundle-options').clientHeight > 750",
      ),
    );
    await b.evaluate(
      "document.getElementById('bundle-options').scrollTop=document.getElementById('bundle-options').scrollHeight",
    );
    assert.ok(
      await b.evaluate(
        "document.querySelector('#bundle-options button:last-child').getBoundingClientRect().bottom <= innerHeight - 8",
      ),
    );
    console.log(
      "bundle count",
      await b.evaluate(
        "document.getElementById('bundle-select').options.length - 1",
      ),
    );
    console.log("screenshot", await b.screenshot("bundle-only-real-list"));
    await b.evaluate(
      "document.getElementById('bundle-query').value='terminal';document.getElementById('bundle-query').dispatchEvent(new Event('input',{bubbles:true}))",
    );
    assert.ok(
      await b.evaluate(
        "Array.from(document.querySelectorAll('#bundle-options button')).some(b=>b.textContent==='Terminal.app')",
      ),
    );
    await b.evaluate(
      "document.getElementById('dropdown-filter-trigger').click()",
    );
    assert.equal(
      await b.evaluate("document.getElementById('bundle-menu').hidden"),
      true,
    );
    assert.equal(
      await b.evaluate(
        "document.getElementById('sa-search-field').closest('#dropdown-menu-advanced') !== null",
      ),
      true,
    );
    console.log("screenshot", await b.screenshot("restored-language-controls"));
    await b.evaluate("document.getElementById('advanced-trigger').click()");
    assert.equal(
      await b.evaluate(
        "document.getElementById('dropdown-filter').classList.contains('is-active')",
      ),
      false,
    );
    assert.equal(
      await b.evaluate(
        "document.getElementById('advanced-trigger').classList.contains('is-info')",
      ),
      true,
    );
    assert.ok(
      await b.evaluate(
        "document.getElementById('advanced-trigger').getBoundingClientRect().width <= 31",
      ),
    );
    assert.ok(
      await b.evaluate(
        "(() => {const p=document.getElementById('dropdown-menu-advanced').getBoundingClientRect();return p.left>=0 && p.right<=innerWidth && p.bottom<=innerHeight})()",
      ),
    );
    console.log(
      "screenshot",
      await b.screenshot("independent-advanced-search"),
    );
    // Clearing every checkbox removes the API filter, while l= keeps the
    // controls unchecked when this page is reloaded or revisited.
    await b.evaluate(
      "for(const e of document.querySelectorAll('input[name=language]')){e.checked=false;e.dispatchEvent(new Event('change'));}document.getElementById('search-form').requestSubmit(document.getElementById('sa-search-button'))",
    );
    await b.until(
      ready + " && new URL(location.href).searchParams.get('l') === ''",
    );
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('input[name=language]:checked').length",
      ),
      0,
    );
    const allLanguages = await (await fetch(
      base + "/api/macos/26/search/advanced?c=key&o=equal&q=Open&size=1",
    )).json();
    assert.ok(allLanguages.total > 0);
    assert.equal(
      await b.evaluate(
        "Number(document.getElementById('total-count').textContent.replaceAll(',',''))",
      ),
      allLanguages.total,
    );
    console.log("unfiltered language total", allLanguages.total);
    const unfilteredURL = await b.evaluate("location.href");
    await b.rawNavigate(unfilteredURL);
    await b.until(ready);
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('input[name=language]:checked').length",
      ),
      0,
    );
    assert.equal(
      await b.evaluate(
        "Number(document.getElementById('total-count').textContent.replaceAll(',',''))",
      ),
      allLanguages.total,
    );
    assert.equal(
      await b.evaluate(
        "performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/macos/26/search/advanced?')).every(e=>!new URL(e.name).searchParams.has('l'))",
      ),
      true,
    );
    // Empty landing pages retain the original random bundle search.
    await b.rawNavigate(base + "/ios/15");
    await b.until(
      "location.pathname === '/ios/15' && document.getElementById('total-count')?.textContent !== '' && document.getElementById('search-status').dataset.phase === 'idle'",
    );
    assert.equal(
      await b.evaluate(
        "performance.getEntriesByType('resource').some(e => e.name.includes('/api/ios/15/search?'))",
      ),
      true,
    );
    await b.rawNavigate(
      base +
        "/?c=key&o=equal&l=English&l=French&l=German&l=Italian&l=Japanese&l=Spanish",
    );
    await b.until(
      "location.pathname==='/' && document.querySelector('#table.tabulator') && document.getElementById('sa-search-error')?.hidden === false",
    );
    assert.equal(
      await b.evaluate(
        "document.getElementById('search-status').dataset.phase",
      ),
      "idle",
    );
    assert.equal(
      await b.evaluate(
        "performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/')).length",
      ),
      0,
    );
    assert.equal(
      await b.evaluate(
        "document.getElementById('advanced-trigger').getAttribute('aria-expanded')",
      ),
      "true",
    );
    console.log("screenshot", await b.screenshot("empty-advanced-guidance"));
    const beforeDisabled = await b.evaluate(
      "({url:location.href,history:history.length})",
    );
    assert.equal(
      await b.evaluate("document.getElementById('search-button').disabled"),
      true,
    );
    await b.mouseClick("#search-button");
    assert.deepEqual(
      await b.evaluate("({url:location.href,history:history.length})"),
      beforeDisabled,
    );
    assert.equal(
      await b.evaluate(
        "document.getElementById('advanced-trigger').getAttribute('aria-expanded')",
      ),
      "true",
    );
    assert.equal(
      await b.evaluate("document.getElementById('search-button').disabled"),
      true,
    );
    assert.equal(
      await b.evaluate(
        "performance.getEntriesByType('resource').filter(e=>e.name.includes('/api/')).length",
      ),
      0,
    );
  },
);
