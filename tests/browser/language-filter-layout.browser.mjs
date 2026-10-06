import test from "node:test";
import assert from "node:assert/strict";
import { localBrowser } from "../helpers/local-browser.mjs";
import legacyOptions from "../fixtures/legacy-language-options.json" with {
  type: "json",
};

test(
  "compact language popup: unchanged choices/defaults, equal columns, no overflow",
  {
    skip: process.env.ALLOW_RELEASE_REVIEW_TEST !== "1",
    timeout: 120000,
  },
  async (t) => {
    const b = await localBrowser(t);
    for (const path of ["/ios/27", "/macos/27"]) {
      await b.viewport(1440, 1000);
      await b.rawNavigate("http://127.0.0.1:8084" + path + "?q=Open");
      await b.until("document.querySelector('#table.tabulator') !== null");
      await b.mouseClick("#dropdown-filter-trigger");
      for (const [width, height] of [[1024, 650], [1440, 1000], [1920, 1000]]) {
        await b.viewport(width, height);
        await b.evaluate(
          "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
        );
        const layout = await b.evaluate(`(() => {
        const panel = document.getElementById('dropdown-menu-filter');
        const content = panel.firstElementChild;
        const p = panel.getBoundingClientRect();
        const rows = Array.from(document.querySelectorAll('input[name=language]')).map(input => {
          const wrapper = input.parentElement, label = input.nextElementSibling;
          const r = label.getBoundingClientRect();
          const range = document.createRange(); range.selectNodeContents(label);
          const text = range.getBoundingClientRect();
          return {name:input.value,id:input.id,className:wrapper.className,checked:input.checked,
            x:r.x,y:r.y,width:r.width,height:r.height,
            contained:text.left >= r.left && text.right <= r.right && text.top >= r.top && text.bottom <= r.bottom};
        });
        return {rows,width:p.width,left:p.left,right:p.right,bottom:p.bottom,
          overflow:content.scrollWidth > content.clientWidth,
          advancedInside:!!document.getElementById('sa-search-field').closest('#dropdown-menu-filter'),
          extraControls:document.querySelectorAll('#language-query,.filter-chips').length};
      })()`);
        assert.deepEqual(
          layout.rows.map(({ name, id, className, checked }) => ({
            name,
            id,
            className,
            checked,
          })),
          legacyOptions,
        );
        assert.equal(layout.rows.length, 62);
        assert.ok(Math.abs(layout.width - 860) < 1);
        assert.ok(
          layout.left >= 0 && layout.right <= width && layout.bottom <= height,
        );
        assert.equal(layout.overflow, false);
        assert.equal(layout.advancedInside, false);
        assert.equal(layout.extraControls, 0);
        assert.equal(
          await b.evaluate(`(() => {
          const heading = document.getElementById('language-presets-heading');
          const section = heading.closest('section');
          const preset = document.getElementById('language-presets');
          const languageBottom = Math.max(...Array.from(document.querySelectorAll('input[name=language] + label')).map(e=>e.getBoundingClientRect().bottom));
          const platformTop = document.querySelector('.platform-row').getBoundingClientRect().top;
          return heading.textContent === 'Language Presets' && section.contains(preset)
            && section.getAttribute('aria-labelledby') === heading.id
            && heading.getBoundingClientRect().top > languageBottom
            && preset.getBoundingClientRect().top >= heading.getBoundingClientRect().bottom
            && section.getBoundingClientRect().bottom < platformTop;
        })()`),
          true,
          "presets form a labeled section between languages and Platform",
        );
        assert.equal(
          await b.evaluate(
            "document.querySelectorAll('#dropdown-filter-trigger svg.bi-globe').length",
          ),
          1,
        );
        const platforms = await b.evaluate(
          `Array.from(document.querySelectorAll('#dropdown-menu-filter .platform-row')).map(row=>({
          platform:row.dataset.platform,
          label:row.getAttribute('aria-label'),
          links:Array.from(row.querySelectorAll('a')).map(a=>({
            path:a.dataset.searchPath,
            url:a.href,
            active:a.classList.contains('is-selected'),
            y:a.getBoundingClientRect().y
          }))
        }))`,
        );
        assert.deepEqual(platforms.map((p) => p.platform), ["ios", "macos"]);
        for (const p of platforms) {
          assert.equal(p.links.length, 6);
          assert.ok(
            p.links.every((l) => l.path.startsWith("/" + p.platform + "/")),
          );
          assert.ok(p.links.every((l) => Math.abs(l.y - p.links[0].y) < 1));
          assert.ok(
            p.links.every((l) =>
              new URL(l.url).searchParams.get("q") === "Open"
            ),
          );
          assert.deepEqual(
            p.links.filter((l) => l.active).map((l) => l.path),
            path.startsWith("/" + p.platform + "/") ? [path] : [],
          );
        }
        assert.ok(platforms[0].links[0].y < platforms[1].links[0].y);
        for (let i = 0; i < layout.rows.length; i++) {
          const row = layout.rows[i];
          assert.ok(
            Math.abs(row.width - layout.rows[0].width) < 1,
            row.name + " width",
          );
          assert.ok(
            Math.abs(row.height - layout.rows[0].height) < 1,
            row.name + " height",
          );
          assert.ok(row.contained, row.name + " text overflow");
          assert.ok(
            Math.abs(row.x - layout.rows[i % 6].x) < 1,
            row.name + " column",
          );
          assert.ok(
            Math.abs(row.y - layout.rows[Math.floor(i / 6) * 6].y) < 1,
            row.name + " row",
          );
        }
      }
      for (
        const id of [
          "checkbox-kazakh",
          "checkbox-oriya",
          "checkbox-simplified_chinese",
          "checkbox-traditional_chinese",
        ]
      ) {
        const before = await b.evaluate(
          `document.getElementById(${JSON.stringify(id)}).checked`,
        );
        await b.mouseClick(`label[for=${id}]`);
        assert.equal(
          await b.evaluate(
            `document.getElementById(${JSON.stringify(id)}).checked`,
          ),
          !before,
        );
        assert.equal(
          await b.evaluate(
            "document.getElementById('dropdown-filter').classList.contains('is-active')",
          ),
          true,
        );
      }
    }
    await b.viewport(1440, 1000);
    await b.evaluate(
      "new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))",
    );
    console.log("screenshot", await b.screenshot("compact-language-popup"));
  },
);
