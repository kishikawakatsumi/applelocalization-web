import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { localBrowser } from "../helpers/local-browser.mjs";

test(
  "actual UI: URL encoding, history, paging, bundle/OS links, empty filters and late responses",
  {
    skip: process.env.ALLOW_SEARCH_HISTORY_TEST !== "1",
    timeout: 180000,
  },
  async (t) => {
    const server = spawn("deno", [
      "run",
      "--node-modules-dir=none",
      "--frozen",
      "--allow-read",
      "--allow-net=127.0.0.1",
      "tests/helpers/search-history-server.ts",
    ], { stdio: ["ignore", "pipe", "pipe"] });
    t.after(() => server.kill());
    const port = await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(Error("Fixture startup timed out")),
        15000,
      );
      let output = "";
      server.stdout.on("data", (chunk) => {
        output += chunk;
        const m = output.match(/FIXTURE_PORT=(\d+)/);
        if (m) {
          clearTimeout(timer);
          resolve(m[1]);
        }
      });
      server.once("error", reject);
      server.once("exit", (code) => {
        clearTimeout(timer);
        reject(Error("Fixture exited " + code));
      });
      server.stderr.on("data", (x) => process.stderr.write(x));
    });
    const origin = "http://127.0.0.1:" + port, b = await localBrowser(t);
    await b.viewport(1440, 1000);
    const ready =
      "document.querySelector('#table.tabulator') && !document.getElementById('search-field').disabled && document.getElementById('total-count').textContent !== ''";
    const result = (q) =>
      `${ready} && document.querySelector('.tabulator-cell[tabulator-field=target]')?.textContent === ${
        JSON.stringify(q)
      }`;
    const submit = async (q, advanced = false) => {
      await b.evaluate(
        `document.getElementById(${
          JSON.stringify(advanced ? "sa-search-field" : "search-field")
        }).focus();document.getElementById(${
          JSON.stringify(advanced ? "sa-search-field" : "search-field")
        }).value=${
          JSON.stringify(q)
        };document.getElementById('search-form').requestSubmit(document.getElementById(${
          JSON.stringify(advanced ? "sa-search-button" : "search-button")
        }))`,
      );
    };
    const params = async () =>
      new URL(await b.evaluate("location.href")).searchParams;
    // Landing page runs a random bundle search; Back restores the same sample.
    await b.rawNavigate(origin + "/macos/26");
    await b.until(result("sample"));
    assert.equal(await b.evaluate(`(() => {
      const icons = document.querySelectorAll('svg.bi-globe, svg.bi-sliders');
      return icons.length === 3 && Array.from(icons).every(icon => {
        const rect = icon.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0
          && icon.getAttribute('aria-hidden') === 'true'
          && getComputedStyle(icon).fill === getComputedStyle(icon).color;
      });
    })()`), true, "Bootstrap icons render at text size and inherit the surrounding color");
    const spinnerVisible =
      "document.getElementById('search-spinner').getBoundingClientRect().width > 0";
    assert.equal(await b.evaluate(spinnerVisible), false);
    console.log("screenshot", await b.screenshot("random-landing"));
    const defaults = await b.evaluate(
      "Array.from(document.querySelectorAll('input[name=language]:checked')).map(x=>x.value)",
    );
    const sampleBefore =
      (await (await fetch(origin + "/fixture-requests")).json()).at(-1);
    assert.ok(
      (await b.evaluate(
        "Array.from(document.getElementById('bundle-select').options).map(o=>o.value)",
      )).includes(
        new URL(sampleBefore, origin).searchParams.get("b"),
      ),
    );
    assert.equal(await b.evaluate("location.search"), "");
    assert.equal(
      await b.evaluate("document.getElementById('bundle-select').value"),
      "",
    );
    await b.evaluate(
      "for(const e of document.querySelectorAll('input[name=language]')){e.checked=e.value==='Japanese';e.dispatchEvent(new Event('change'));}",
    );
    await submit("Open");
    await b.until(result("Open"));
    assert.deepEqual((await params()).getAll("l"), ["Japanese"]);
    await b.evaluate("history.back()");
    await b.until(result("sample") + " && location.search === ''");
    assert.deepEqual(
      await b.evaluate(
        "Array.from(document.querySelectorAll('input[name=language]:checked')).map(x=>x.value)",
      ),
      defaults,
    );
    const sampleAfter =
      (await (await fetch(origin + "/fixture-requests")).json()).at(-1);
    assert.equal(
      new URL(sampleBefore, origin).searchParams.get("b"),
      new URL(sampleAfter, origin).searchParams.get("b"),
    );
    await b.rawNavigate(origin + "/macos/26?q=start&l=Japanese");
    await b.until(result("start"));
    const initial = await b.evaluate("history.length");
    const special = "  A&B + C++ # 日本語 100%  ";
    await submit(special);
    await b.until(result(special));
    assert.equal((await params()).get("q"), special);
    assert.deepEqual((await params()).getAll("l"), ["Japanese"]);
    assert.equal(await b.evaluate("history.length"), initial + 1);
    await submit(special);
    await b.until(result(special));
    assert.equal(await b.evaluate("history.length"), initial + 1);
    await submit("advanced &+#", true);
    await b.until(result("advanced &+#"));
    assert.equal((await params()).get("c"), "key");
    await b.evaluate("history.back()");
    await b.until(result(special));
    assert.equal(
      await b.evaluate("document.getElementById('sa-search-field').value"),
      "",
    );
    assert.equal(
      await b.evaluate("document.getElementById('search-field').value"),
      special,
    );
    await b.evaluate("history.forward()");
    await b.until(result("advanced &+#"));
    assert.equal(
      await b.evaluate("document.getElementById('sa-search-field').value"),
      "advanced &+#",
    );
    // Real anchors support ordinary click, modified click, and copying the URL.
    const link = new URL(
      await b.evaluate("document.querySelector('a[data-search-bundle]').href"),
    );
    assert.equal(link.searchParams.get("q"), "advanced &+#");
    assert.equal(link.searchParams.get("b"), "A&B + #.app");
    assert.equal(link.searchParams.get("c"), "key");
    assert.deepEqual(link.searchParams.getAll("l"), ["Japanese"]);
    await b.rawNavigate(link.href);
    await b.until(result("advanced &+#"));
    const osLink = await b.evaluate(
      "document.querySelector('a[data-search-path=\"/ios/27\"]').href",
    );
    await b.rawNavigate(osLink);
    await b.until("location.pathname==='/ios/27' && " + result("advanced &+#"));
    assert.equal(
      await b.evaluate("document.getElementById('bundle-select').value"),
      "A&B + #.app",
    );
    assert.deepEqual((await params()).getAll("l"), ["Japanese"]);
    // Unchecked means all languages; l= preserves that UI state in page URLs,
    // but the API must receive no language condition.
    await b.evaluate(
      "for(const e of document.querySelectorAll('input[name=language]')){e.checked=false;e.dispatchEvent(new Event('change'));}",
    );
    await submit("empty");
    await b.until(result("empty"));
    assert.deepEqual((await params()).getAll("l"), [""]);
    const emptyURL = await b.evaluate("location.href");
    await b.rawNavigate(emptyURL);
    await b.until(result("empty"));
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('input[name=language]:checked').length",
      ),
      0,
    );
    const allLanguageRequest = new URL(
      (await (await fetch(origin + "/fixture-requests")).json()).at(-1),
      origin,
    );
    assert.equal(allLanguageRequest.searchParams.has("l"), false);
    await b.evaluate("document.getElementById('checkbox-japanese').click()");
    await submit("Japanese only");
    await b.until(result("Japanese only"));
    assert.deepEqual((await params()).getAll("l"), ["Japanese"]);
    await b.evaluate("history.back()");
    await b.until(result("empty"));
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('input[name=language]:checked').length",
      ),
      0,
    );
    await b.evaluate("history.forward()");
    await b.until(result("Japanese only"));
    assert.equal(
      await b.evaluate("document.getElementById('checkbox-japanese').checked"),
      true,
    );
    // Progressive loading must not create a browser history entry.
    await b.rawNavigate(origin + "/macos/26?q=paging&l=English");
    await b.until(ready);
    const beforePaging = await b.evaluate("history.length");
    await b.evaluate(
      "const holder=document.querySelector('.tabulator-tableholder');holder.scrollTop=holder.scrollHeight;holder.dispatchEvent(new Event('scroll'));",
    );
    await b.until(
      "parseInt(document.getElementById('data-count').textContent.replaceAll(',',''))>200",
    );
    assert.equal(await b.evaluate("history.length"), beforePaging);
    assert.equal((await params()).has("page"), false);
    // Additional-page failure keeps existing rows; Retry requests page 2 only.
    await submit("retry-page");
    await b.until(ready);
    const scroll =
      "{const holder=document.querySelector('.tabulator-tableholder');holder.scrollTop=holder.scrollHeight;holder.dispatchEvent(new Event('scroll'));}";
    await b.evaluate(scroll);
    await b.until(
      "document.getElementById('search-status').dataset.phase==='error'",
    );
    assert.match(
      await b.evaluate(
        "document.getElementById('search-status-message').title",
      ),
      /timed out/,
    );
    assert.equal(
      await b.evaluate("document.getElementById('data-count').textContent"),
      "200 /",
    );
    assert.equal(
      await b.evaluate("document.querySelectorAll('.tabulator-alert').length"),
      0,
    );
    assert.equal(
      await b.evaluate("document.getElementById('search-field').disabled"),
      false,
    );
    console.log("screenshot", await b.screenshot("search-retry"));
    assert.equal(await b.evaluate(spinnerVisible), false);
    assert.ok(
      await b.evaluate(`(() => {
      const table = document.getElementById('table').getBoundingClientRect();
      const status = document.getElementById('search-status').getBoundingClientRect();
      const expected = innerHeight - document.getElementById('header').offsetHeight - 2.25 * parseFloat(getComputedStyle(document.documentElement).fontSize);
      return Math.abs(table.height - expected) < 2 && status.bottom < table.top && status.left >= 0 && status.right <= innerWidth && document.getElementById('search-summary').contains(document.getElementById('search-status'));
    })()`),
    );
    assert.equal(
      await b.evaluate(
        "getComputedStyle(document.getElementById('search-status')).position",
      ),
      "static",
    );
    assert.equal(
      await b.evaluate(
        "getComputedStyle(document.getElementById('search-retry')).pointerEvents",
      ),
      "auto",
    );
    const heightWithStatus = await b.evaluate(
      "document.getElementById('table').getBoundingClientRect().height",
    );
    assert.ok(
      await b.evaluate(
        "document.getElementById('search-retry').getBoundingClientRect().bottom <= innerHeight",
      ),
    );
    await b.evaluate(scroll);
    await b.evaluate(scroll);
    await b.evaluate("document.getElementById('search-retry').click()");
    await b.until(
      "document.getElementById('data-count').textContent==='400 /'",
    );
    const retries = (await (await fetch(origin + "/fixture-requests")).json())
      .map((p) => new URL(p, origin)).filter((u) =>
        u.searchParams.get("q") === "retry-page"
      );
    assert.equal(
      await b.evaluate(
        "document.getElementById('table').getBoundingClientRect().height",
      ),
      heightWithStatus,
    );
    assert.deepEqual(retries.map((u) => u.searchParams.get("page")), [
      "1",
      "2",
      "2",
    ]);
    // A delayed additional page must leave both results and search input usable.
    await submit("slow-page");
    await b.until(ready);
    await b.evaluate(scroll);
    await b.until(
      "document.getElementById('search-status-message').textContent==='Loading more results…'",
    );
    assert.equal(await b.evaluate(spinnerVisible), true);
    assert.equal(
      await b.evaluate(
        "document.getElementById('search-status-message').classList.contains('is-sr-only')",
      ),
      true,
    );
    assert.equal(
      await b.evaluate("document.getElementById('search-counts').hidden"),
      false,
    );
    assert.equal(
      await b.evaluate(
        "getComputedStyle(document.getElementById('search-spinner')).animationName",
      ),
      "search-spinner-rotate",
    );
    console.log("screenshot", await b.screenshot("search-loading-spinner"));
    assert.ok(
      await b.evaluate(
        "document.querySelectorAll('.tabulator-row:not(.tabulator-group)').length>0",
      ),
    );
    assert.equal(
      await b.evaluate("document.querySelectorAll('.tabulator-alert').length"),
      0,
    );
    assert.equal(
      await b.evaluate("document.getElementById('search-field').disabled"),
      false,
    );
    await submit("replacement");
    await b.until(result("replacement"));
    assert.equal(await b.evaluate(spinnerVisible), false);
    await b.evaluate("new Promise(r=>setTimeout(r,1400))");
    assert.equal(
      await b.evaluate("document.getElementById('total-count').textContent"),
      "1",
    );
    assert.equal(
      await b.evaluate(
        "document.querySelector('.tabulator-cell[tabulator-field=target]').textContent",
      ),
      "replacement",
    );
    // First-page errors are explicit and retryable too.
    await submit("retry-first");
    await b.until(
      "document.getElementById('search-status').dataset.phase==='error'",
    );
    assert.match(
      await b.evaluate(
        "document.getElementById('search-status-message').title",
      ),
      /HTTP 500/,
    );
    await b.evaluate("document.getElementById('search-retry').click()");
    await b.until(result("retry-first"));
    // A delayed response must not replace the result restored by Back.
    await submit("fast");
    await b.until(result("fast"));
    await submit("slow");
    await b.until(
      "document.getElementById('search-status').dataset.phase==='loading'",
    );
    assert.equal(await b.evaluate(spinnerVisible), true);
    assert.equal(
      await b.evaluate("document.getElementById('search-counts').hidden"),
      true,
    );
    assert.equal(
      await b.evaluate(
        "document.querySelector('.tabulator-placeholder')?.textContent ?? ''",
      ),
      "",
    );
    assert.equal(
      await b.evaluate(
        "document.getElementById('search-status-message').textContent",
      ),
      "Searching…",
    );
    console.log("screenshot", await b.screenshot("inline-initial-search"));
    assert.equal(
      await b.evaluate("document.getElementById('search-field').disabled"),
      false,
    );
    await b.evaluate("history.back()");
    await b.until(result("fast"));
    await b.evaluate("new Promise(r=>setTimeout(r,1100))");
    assert.equal((await params()).get("q"), "fast");
    assert.equal(
      await b.evaluate(
        "document.querySelector('.tabulator-cell[tabulator-field=target]').textContent",
      ),
      "fast",
    );
    assert.equal(
      await b.evaluate("document.getElementById('total-count').textContent"),
      "1",
    );
    const requests = await (await fetch(origin + "/fixture-requests")).json();
    assert.ok(
      requests.some((p) =>
        new URL(p, origin).searchParams.get("q") === special
      ),
    );
    console.log("screenshot", await b.screenshot("search-history-final"));
    // Language choices stay in place; only advanced search has its own popup.
    assert.equal(
      await b.evaluate(
        "document.getElementById('sa-search-field').closest('#dropdown-menu-advanced') !== null",
      ),
      true,
    );
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('#language-query, .filter-chips').length",
      ),
      0,
    );
    const beforeFilter = await b.evaluate("location.href");
    await b.evaluate("document.getElementById('bundle-trigger').click()");
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('#bundle-options button').length",
      ),
      183,
    );
    assert.ok(
      await b.evaluate(
        "document.getElementById('bundle-options').clientHeight > 750",
      ),
    );
    assert.ok(
      await b.evaluate(
        "Math.abs(document.getElementById('bundle-menu').getBoundingClientRect().bottom - (innerHeight - 8)) < 2",
      ),
    );
    const filterBundles = async (q) =>
      b.evaluate(
        `document.getElementById('bundle-query').value=${
          JSON.stringify(q)
        };document.getElementById('bundle-query').dispatchEvent(new Event('input',{bubbles:true}))`,
      );
    await filterBundles("example");
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('#bundle-options button').length",
      ),
      181,
    );
    await filterBundles("xyz-no-match");
    assert.equal(
      await b.evaluate("document.querySelector('.bundle-empty').hidden"),
      false,
    );
    await filterBundles("");
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('#bundle-options button').length",
      ),
      183,
    );
    await b.evaluate(
      "document.getElementById('bundle-options').scrollTop=document.getElementById('bundle-options').scrollHeight",
    );
    assert.ok(
      await b.evaluate(
        "document.querySelector('#bundle-options button:last-child').getBoundingClientRect().bottom <= innerHeight - 8",
      ),
    );
    await filterBundles("terminal");
    assert.deepEqual(
      await b.evaluate(
        "Array.from(document.querySelectorAll('#bundle-options button')).map(b=>b.dataset.bundleValue)",
      ),
      ["", "Terminal.app"],
    );
    assert.equal(await b.evaluate("location.href"), beforeFilter);
    await b.evaluate(
      "document.querySelector('#bundle-options button[data-bundle-value=\"Terminal.app\"]').click()",
    );
    assert.equal(
      await b.evaluate("document.getElementById('bundle-select').value"),
      "Terminal.app",
    );
    assert.equal(
      await b.evaluate("document.getElementById('bundle-menu').hidden"),
      true,
    );
    await submit("bundle-only");
    await b.until(result("bundle-only"));
    assert.equal((await params()).get("b"), "Terminal.app");
    await b.evaluate("document.getElementById('bundle-trigger').click()");
    assert.equal(
      await b.evaluate("document.getElementById('bundle-query').value"),
      "",
    );
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('#bundle-options button').length",
      ),
      183,
    );
    console.log("screenshot", await b.screenshot("bundle-only-tall-list"));
    await b.viewport(1024, 650);
    await b.until(
      "document.getElementById('bundle-menu').getBoundingClientRect().bottom <= 643",
    );
    assert.ok(
      await b.evaluate(
        "document.getElementById('bundle-options').clientHeight > 400",
      ),
    );
    await b.evaluate(
      "document.getElementById('bundle-query').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}))",
    );
    assert.equal(
      await b.evaluate("document.activeElement.dataset.bundleValue"),
      "",
    );
    await b.evaluate(
      "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true}))",
    );
    assert.equal(
      await b.evaluate("document.activeElement.dataset.bundleValue"),
      await b.evaluate(
        "document.querySelector('#bundle-options button:last-child').dataset.bundleValue",
      ),
    );
    await b.evaluate(
      "document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
    );
    assert.equal(
      await b.evaluate("document.activeElement.id"),
      "bundle-trigger",
    );
    assert.equal(
      await b.evaluate("document.getElementById('bundle-menu').hidden"),
      true,
    );
    await b.evaluate("history.back()");
    await b.until(result("fast"));
    assert.equal(
      await b.evaluate("document.getElementById('bundle-trigger').title"),
      "All bundles",
    );
    // A compact icon opens advanced search, but highlights only applied state.
    assert.equal(
      await b.evaluate(
        "document.getElementById('advanced-trigger').classList.contains('is-info')",
      ),
      false,
    );
    await b.evaluate("document.getElementById('advanced-trigger').click()");
    assert.equal(
      await b.evaluate("document.activeElement.id"),
      "sa-search-field",
    );
    assert.equal(
      await b.evaluate(
        "document.getElementById('advanced-trigger').getAttribute('aria-expanded')",
      ),
      "true",
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
    assert.equal(
      await b.evaluate(
        "document.getElementById('advanced-trigger').classList.contains('is-info')",
      ),
      false,
    );
    await submit("advanced icon", true);
    await b.until(result("advanced icon"));
    assert.equal((await params()).get("c"), "key");
    assert.equal(
      await b.evaluate(
        "document.getElementById('advanced-trigger').classList.contains('is-info')",
      ),
      true,
    );
    assert.equal(
      await b.evaluate(
        "document.getElementById('advanced-trigger').getAttribute('aria-expanded')",
      ),
      "false",
    );
    await b.evaluate("document.getElementById('search-field').focus()");
    assert.equal(
      await b.evaluate(
        "document.getElementById('advanced-trigger').classList.contains('is-info')",
      ),
      true,
    );
    await submit("normal again");
    await b.until(result("normal again"));
    assert.equal(
      await b.evaluate(
        "document.getElementById('advanced-trigger').classList.contains('is-info')",
      ),
      false,
    );
    await b.evaluate("history.back()");
    await b.until(result("advanced icon"));
    assert.equal(
      await b.evaluate(
        "document.getElementById('advanced-trigger').classList.contains('is-info')",
      ),
      true,
    );
    await b.evaluate("history.forward()");
    await b.until(result("normal again"));
    assert.equal(
      await b.evaluate(
        "document.getElementById('advanced-trigger').classList.contains('is-info')",
      ),
      false,
    );
    await b.evaluate(
      "document.getElementById('advanced-trigger').click();document.getElementById('dropdown-filter-trigger').click()",
    );
    assert.equal(
      await b.evaluate(
        "document.getElementById('advanced-trigger').getAttribute('aria-expanded')",
      ),
      "false",
    );
    await b.evaluate("document.getElementById('advanced-trigger').click()");
    assert.equal(
      await b.evaluate(
        "document.getElementById('dropdown-filter').classList.contains('is-active')",
      ),
      false,
    );
    console.log("screenshot", await b.screenshot("advanced-icon-popup"));
    await b.evaluate(
      "document.getElementById('sa-search-field').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))",
    );
    assert.equal(
      await b.evaluate("document.activeElement.id"),
      "advanced-trigger",
    );
    assert.equal(
      await b.evaluate(
        "document.getElementById('advanced-trigger').getAttribute('aria-expanded')",
      ),
      "false",
    );
    // Presets reuse the original localStorage key, never auto-search or drop
    // exact locale metadata from older saved combinations.
    const storageKey = "applelocalization.language-presets.v1";
    const presetURL = origin + "/macos/26?q=preset-test&l=Japanese";
    await b.evaluate(
      `localStorage.setItem(${
        JSON.stringify(storageKey)
      }, JSON.stringify([{name:'Older preset',languages:['Japanese'],locales:['en-AU']}]))`,
    );
    await b.rawNavigate(presetURL);
    await b.until(result("preset-test"));
    await b.evaluate(
      "document.getElementById('dropdown-filter-trigger').click()",
    );
    const choosePreset = async (value) => {
      // Native selects emit input before change. Header-level input handling
      // must not clear the selected preset before its change handler applies it.
      await b.evaluate(
        `document.getElementById('language-presets').value=${
          JSON.stringify(value)
        };document.getElementById('language-presets').dispatchEvent(new Event('input',{bubbles:true}))`,
      );
      assert.equal(
        await b.evaluate("document.getElementById('language-presets').value"),
        value,
        "input must retain the preset until change applies its languages",
      );
      await b.evaluate(
        "document.getElementById('language-presets').dispatchEvent(new Event('change',{bubbles:true}))",
      );
      assert.equal(
        await b.evaluate("document.getElementById('preset-notice').hidden"),
        true,
        "loading a preset does not display a status message",
      );
    };
    const savePreset = async (name) =>
      b.evaluate(
        `document.getElementById('preset-name').value=${
          JSON.stringify(name)
        };document.getElementById('preset-save').click()`,
      );
    await choosePreset("saved:Older preset");
    await savePreset("Older preset copy");
    assert.equal(
      await b.evaluate("document.getElementById('preset-notice').hidden"),
      true,
      "saving a preset does not display a status message",
    );
    assert.deepEqual(
      await b.evaluate(
        `JSON.parse(localStorage.getItem(${
          JSON.stringify(storageKey)
        }))[1].locales`,
      ),
      ["en-AU"],
    );
    await choosePreset("default:en-ja");
    assert.deepEqual(
      await b.evaluate(
        "Array.from(document.querySelectorAll('input[name=language]:checked')).map(i=>i.value)",
      ),
      ["English", "Japanese"],
    );
    assert.equal(await b.evaluate("location.href"), presetURL);
    const presetName = "Daily <test> & 日本語";
    await savePreset(presetName);
    const saved = await b.evaluate(
      `JSON.parse(localStorage.getItem(${JSON.stringify(storageKey)}))`,
    );
    assert.deepEqual(saved[2], {
      name: presetName,
      languages: ["English", "Japanese"],
      locales: [],
    });
    await savePreset(presetName);
    assert.match(
      await b.evaluate("document.getElementById('preset-notice').textContent"),
      /already saved/,
    );
    assert.equal(
      await b.evaluate(
        `JSON.parse(localStorage.getItem(${
          JSON.stringify(storageKey)
        })).length`,
      ),
      3,
    );
    await b.rawNavigate(presetURL);
    await b.until(result("preset-test"));
    await choosePreset("saved:" + presetName);
    assert.deepEqual(
      await b.evaluate(
        "Array.from(document.querySelectorAll('input[name=language]:checked')).map(i=>i.value)",
      ),
      ["English", "Japanese"],
    );
    await submit("preset-test");
    await b.until(result("preset-test"));
    assert.deepEqual((await params()).getAll("l"), ["English", "Japanese"]);
    await b.evaluate(
      "for(const i of document.querySelectorAll('input[name=language]')){i.checked=false;i.dispatchEvent(new Event('change'))}",
    );
    await savePreset("All languages");
    await choosePreset("default:en-ja");
    await choosePreset("saved:All languages");
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('input[name=language]:checked').length",
      ),
      0,
    );
    await submit("preset-all");
    await b.until(result("preset-all"));
    assert.deepEqual((await params()).getAll("l"), [""]);
    await choosePreset("saved:" + presetName);
    await b.evaluate("document.getElementById('preset-delete').click()");
    assert.equal(
      await b.evaluate("document.getElementById('preset-notice').hidden"),
      true,
      "deleting a preset does not display a status message",
    );
    assert.equal(
      await b.evaluate(
        `JSON.parse(localStorage.getItem(${
          JSON.stringify(storageKey)
        })).some(p=>p.name===${JSON.stringify(presetName)})`,
      ),
      false,
    );
    assert.deepEqual(
      await b.evaluate(
        "Array.from(document.querySelectorAll('input[name=language]:checked')).map(i=>i.value)",
      ),
      ["English", "Japanese"],
    );
    await b.evaluate(
      "window.originalSetItem=Storage.prototype.setItem;Storage.prototype.setItem=function(){throw new Error('test storage unavailable')}",
    );
    await savePreset("Cannot save");
    assert.match(
      await b.evaluate("document.getElementById('preset-notice').textContent"),
      /Could not save/,
    );
    await b.evaluate("Storage.prototype.setItem=window.originalSetItem");
    await choosePreset("default:en-ja");
    await b.evaluate(
      "document.getElementById('dropdown-filter-trigger').click()",
    );
    console.log("screenshot", await b.screenshot("restored-language-presets"));
    // Empty advanced submissions keep the current result/URL and never hit
    // the API. A directly opened invalid URL shows the same local guidance.
    await submit("before empty advanced");
    await b.until(result("before empty advanced"));
    const beforeEmpty = await b.evaluate(
      "({url:location.href,length:history.length})",
    );
    const requestsBeforeEmpty =
      (await (await fetch(origin + "/fixture-requests")).json()).length;
    await b.evaluate("document.getElementById('advanced-trigger').click()");
    await submit("", true);
    assert.equal(
      await b.evaluate("document.getElementById('sa-search-error').hidden"),
      false,
    );
    assert.equal(
      await b.evaluate(
        "document.getElementById('sa-search-field').getAttribute('aria-invalid')",
      ),
      "true",
    );
    assert.equal(
      await b.evaluate("document.activeElement.id"),
      "sa-search-field",
    );
    assert.deepEqual(
      await b.evaluate("({url:location.href,length:history.length})"),
      beforeEmpty,
    );
    assert.equal(
      await b.evaluate(
        "document.querySelector('.tabulator-cell[tabulator-field=target]').textContent",
      ),
      "before empty advanced",
    );
    assert.equal(
      (await (await fetch(origin + "/fixture-requests")).json()).length,
      requestsBeforeEmpty,
    );
    const invalidURL = origin + "/macos/26?c=key&o=equal&l=Japanese";
    await b.rawNavigate(invalidURL);
    await b.until(
      "document.querySelector('#table.tabulator') && document.getElementById('sa-search-error')?.hidden === false",
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
    assert.equal(await b.evaluate("location.href"), invalidURL);
    await b.evaluate(
      "document.getElementById('sa-search-field').value=' ';document.getElementById('sa-search-field').dispatchEvent(new Event('input',{bubbles:true}))",
    );
    assert.equal(
      await b.evaluate("document.getElementById('sa-search-error').hidden"),
      true,
    );
    await submit(" ", true);
    await b.until(result(" "));
    assert.equal((await params()).get("q"), " ");
    await b.evaluate("history.back()");
    await b.until(
      "document.getElementById('sa-search-error')?.hidden === false && location.href === " +
        JSON.stringify(invalidURL),
    );
    await b.evaluate("history.forward()");
    await b.until(result(" "));
    assert.equal(
      await b.evaluate("document.getElementById('sa-search-error').hidden"),
      true,
    );
    await submit("normal still works");
    await b.until(result("normal still works"));
    // Browser-dispatched pointer/keyboard events, not element.click(): labels
    // blur before their default checkbox action and native selects can blur too.
    await b.rawNavigate(origin + "/macos/26?q=pointer&l=Japanese");
    await b.until(result("pointer"));
    await b.mouseClick("#dropdown-filter-trigger");
    await b.mouseClick("label[for=checkbox-english]");
    assert.equal(
      await b.evaluate("document.getElementById('checkbox-english').checked"),
      true,
    );
    assert.equal(
      await b.evaluate(
        "document.getElementById('dropdown-filter').classList.contains('is-active')",
      ),
      true,
    );
    await b.mouseClick("label[for=checkbox-english]");
    assert.equal(
      await b.evaluate("document.getElementById('checkbox-english').checked"),
      false,
    );
    await b.mouseClick("#dropdown-filter-trigger");
    await b.mouseClick("#dropdown-filter-trigger");
    await b.keyPress("Tab", "Tab", 9);
    assert.equal(
      await b.evaluate("document.activeElement.id"),
      "checkbox-english",
    );
    await b.evaluate(
      "Array.from(document.querySelectorAll('input[name=language]')).at(-1).focus()",
    );
    await b.keyPress("Tab", "Tab", 9);
    assert.equal(
      await b.evaluate("document.activeElement.id"),
      "language-presets",
    );
    // Native macOS select popups do not accept renderer CDP key events.
    // Exercise their null-focus transition and selection change separately.
    await b.evaluate(
      "document.getElementById('language-presets').dispatchEvent(new FocusEvent('focusout',{bubbles:true,relatedTarget:null}))",
    );
    await choosePreset("default:en-ja");
    await b.until(
      "document.getElementById('checkbox-english').checked && document.getElementById('checkbox-japanese').checked",
    );
    assert.equal(
      await b.evaluate(
        "document.getElementById('dropdown-filter').classList.contains('is-active')",
      ),
      true,
    );
    await b.mouseClick("#preset-name");
    await b.evaluate(
      "document.getElementById('preset-name').value='Mouse preset'",
    );
    await b.mouseClick("#preset-save");
    assert.ok(
      await b.evaluate(
        `JSON.parse(localStorage.getItem(${
          JSON.stringify(storageKey)
        })).some(p=>p.name==='Mouse preset')`,
      ),
    );
    await b.mouseClick("#search-button");
    await b.until(
      result("pointer") +
        " && new URL(location.href).searchParams.getAll('l').length===2",
    );
    await b.mouseClick("#advanced-trigger");
    assert.equal(
      await b.evaluate("document.getElementById('search-button').disabled"),
      true,
    );
    const beforeDisabledClick = await b.evaluate(
      "({url:location.href,history:history.length})",
    );
    const requestsBeforeDisabled =
      (await (await fetch(origin + "/fixture-requests")).json()).length;
    await b.mouseClick("#search-button");
    assert.equal(
      await b.evaluate("document.getElementById('search-button').disabled"),
      true,
    );
    assert.equal(
      await b.evaluate(
        "document.getElementById('dropdown-advanced').classList.contains('is-active')",
      ),
      true,
    );
    assert.equal(
      await b.evaluate("document.activeElement.id"),
      "sa-search-field",
    );
    assert.deepEqual(
      await b.evaluate("({url:location.href,history:history.length})"),
      beforeDisabledClick,
    );
    assert.equal(
      (await (await fetch(origin + "/fixture-requests")).json()).length,
      requestsBeforeDisabled,
    );
    await b.keyPress("Tab", "Tab", 9, 8);
    await b.keyPress("Tab", "Tab", 9, 8);
    assert.equal(await b.evaluate("document.activeElement.id"), "sa-column");
    assert.equal(
      await b.evaluate("document.getElementById('search-button').disabled"),
      true,
    );
    await b.mouseClick("#sa-search-field");
    await b.evaluate(
      "document.getElementById('sa-search-field').value='mouse advanced'",
    );
    await b.mouseClick("#sa-search-button");
    await b.until(result("mouse advanced"));
    assert.equal((await params()).get("c"), "key");
    await b.mouseClick("#advanced-trigger");
    await b.keyPress("Escape", "Escape", 27);
    assert.equal(
      await b.evaluate("document.getElementById('search-button').disabled"),
      false,
    );
    await b.mouseClick("#search-field");
    await b.evaluate(
      "document.getElementById('search-field').value='keyboard normal'",
    );
    await b.keyPress("Enter", "Enter", 13);
    await b.until(result("keyboard normal"));
    assert.equal((await params()).has("c"), false);
    await b.mouseClick("#advanced-trigger");
    await b.evaluate(
      "document.getElementById('sa-search-field').value='keyboard advanced'",
    );
    await b.keyPress("Enter", "Enter", 13);
    await b.until(result("keyboard advanced"));
    assert.equal((await params()).get("c"), "key");
    // Context details use response provenance, keep text literal and retain
    // resource/component grouping when a group spans progressive pages.
    await b.viewport(1440, 1000);
    await b.rawNavigate(origin + "/macos/26?q=context-ui&l=English");
    await b.until(
      "document.getElementById('data-count').textContent==='200 /'",
    );
    assert.equal(
      await b.evaluate(
        "document.querySelector('.context-group-count').textContent",
      ),
      "200 rows loaded",
    );
    assert.match(
      await b.evaluate(
        "document.querySelector('.context-group-header').title",
      ),
      /A.app.*Localizable.strings.*macos26-os/,
    );
    assert.equal(
      await b.evaluate(
        "document.querySelector('.tabulator-group').offsetHeight <= 30 && !document.querySelector('.context-group-source')",
      ),
      true,
    );
    await b.mouseClick(".context-toggle");
    await b.until("document.querySelector('.translation-detail') !== null");
    const rawTarget =
      'First line %@\nSecond line\t  %lld <img src=x onerror="window.contextXSS=true">';
    assert.equal(
      await b.evaluate(
        "document.querySelector('.context-text-field:last-child .context-value').textContent",
      ),
      rawTarget,
    );
    assert.equal(
      await b.evaluate(
        "!!window.contextXSS || !!document.querySelector('#table img')",
      ),
      false,
    );
    assert.deepEqual(
      await b.evaluate(
        "Array.from(document.querySelectorAll('.context-metadata dd')).map(e=>e.textContent)",
      ),
      [
        "macOS 26.1 · Build 25B78",
        "macos26-os",
        "en",
        "/Applications/A.app",
        "/Applications/A.app/Contents/Resources/en.lproj/Localizable.strings",
      ],
    );
    assert.match(
      await b.evaluate(
        "document.querySelector('.context-visibility').textContent",
      ),
      /Show invisibles/,
    );
    await b.until(
      "document.querySelectorAll('.context-copy svg[data-icon=copy]').length === 2",
    );
    assert.equal(
      await b.evaluate(
        "Array.from(document.querySelectorAll('.context-copy')).every(e=>e.textContent==='' && e.getAttribute('aria-label').startsWith('Copy ') && e.title.startsWith('Copy '))",
      ),
      true,
    );
    await b.mouseClick(".context-visibility input");
    assert.match(
      await b.evaluate(
        "document.querySelector('.context-text-field:last-child .context-value').textContent",
      ),
      /↵\nSecond·line→\t··%lld/,
    );
    await b.evaluate(
      "window.copiedContext=[];Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>window.copiedContext.push(text)}})",
    );
    await b.mouseClick(".context-text-field:last-child .context-copy");
    assert.deepEqual(await b.evaluate("window.copiedContext"), [rawTarget]);
    await b.until(
      "document.querySelector('.context-text-field:last-child .context-copy svg[data-icon=check]')",
    );
    assert.equal(
      await b.evaluate(`(() => {
      const panel=document.querySelector('.translation-detail').getBoundingClientRect();
      const rows=document.querySelectorAll('.tabulator-row:not(.tabulator-group)');
      return panel.width>1000 && panel.right<=innerWidth && rows[1].getBoundingClientRect().top>=panel.bottom-1;
    })()`),
      true,
      "expanded detail stays inside the table without overlapping the next row",
    );
    console.log(
      "screenshot",
      await b.screenshot("translation-context-details"),
    );
    await b.evaluate(
      "navigator.clipboard.writeText=async()=>{throw Error('clipboard unavailable')}",
    );
    await b.mouseClick(".context-text-field .context-copy");
    await b.until(
      "document.querySelector('.context-copy-status').hidden===false",
    );
    await b.mouseClick(".context-toggle");
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('.translation-detail').length",
      ),
      0,
    );
    await b.keyPress("Enter", "Enter", 13);
    await b.until(
      "document.querySelector('.context-visibility input')?.checked === true",
    );
    await b.evaluate(scroll);
    await b.until(
      "document.getElementById('data-count').textContent==='205 /'",
    );
    await b.evaluate(scroll);
    await b.until(
      "Array.from(document.querySelectorAll('.context-group-header')).some(e=>e.title.includes('macos26-appos'))",
    );
    assert.equal(
      await b.evaluate(
        "Array.from(document.querySelectorAll('.context-group-header')).some(e=>e.title.includes('B.app'))",
      ),
      true,
    );
    assert.equal(
      await b.evaluate(
        "Array.from(document.querySelectorAll('.context-group-count')).some(e=>e.textContent==='4 rows loaded')",
      ),
      false,
    );
    await b.evaluate(
      "document.querySelector('.tabulator-tableholder').scrollTop=0",
    );
    await b.until(
      "document.querySelector('.context-group-count')?.textContent==='201 rows loaded'",
    );
    await b.until("document.querySelector('.translation-detail') !== null");
    assert.equal(
      await b.evaluate(
        "document.querySelector('.context-visibility input').checked",
      ),
      true,
    );
    // New searches discard old expansion state and do not guess absent metadata.
    await submit("legacy-context");
    await b.until(result("legacy-context"));
    assert.equal(
      await b.evaluate(
        "document.querySelectorAll('.translation-detail').length",
      ),
      0,
    );
    await b.mouseClick(".context-toggle");
    assert.equal(
      await b.evaluate(
        "document.querySelector('.context-metadata dd').textContent",
      ),
      "Not available",
    );
    // Compact and wide headers reserve the same space across error/retry/done.
    for (const width of [1024, 1920]) {
      await b.viewport(width, 1000);
      const query = `retry-first-${width}`;
      await b.rawNavigate(origin + "/macos/26?q=" + query);
      await b.until(
        "document.getElementById('search-status')?.dataset.phase === 'error'",
      );
      const geometry = `({header:document.getElementById('header').offsetHeight,
        top:document.getElementById('table').getBoundingClientRect().top,
        height:document.getElementById('table').getBoundingClientRect().height})`;
      const failedGeometry = await b.evaluate(geometry);
      assert.equal(
        await b.evaluate(`(() => {
        const status=document.getElementById('search-status').getBoundingClientRect();
        const table=document.getElementById('table').getBoundingClientRect();
        return status.left>=0 && status.right<=innerWidth && status.bottom<table.top;
      })()`),
        true,
      );
      console.log("screenshot", await b.screenshot(`inline-status-${width}`));
      await b.mouseClick("#search-retry");
      await b.until(result(query));
      assert.deepEqual(await b.evaluate(geometry), failedGeometry);
    }
  },
);
