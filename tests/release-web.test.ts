import { strict as assert } from "node:assert";
import { createReleaseWeb, releasePageModel } from "../backend/web.ts";
import legacyOptions from "./fixtures/legacy-language-options.json" with {
  type: "json",
};

Deno.test("existing UI keeps fixed language choices independent of data availability", () => {
  const m = releasePageModel({ platform: "iOS", version: "27.0.1" }, {
    total: 1234,
    languages: ["ja", "en", "en-AU", "da-DK", "da~mac", "new-locale"],
    bundles: ["/A/Test.app", "/B/Test.app", "/C/F.framework"],
  });
  assert.equal(m.path, "/ios/27");
  assert.deepEqual(m.bundles, ["F.framework", "Test.app"]);
  assert.equal(m.count, "1,234");
  assert.ok(m.languages.find((l) => l.name === "Japanese")?.checked);
  assert.deepEqual(
    m.languages,
    legacyOptions.map(({ name, checked }) => ({ name, checked })),
  );
});

Deno.test("real production template serves twelve scoped versions and API without public DB imports", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/templates`);
    await Deno.copyFile("frontend/index.html", `${dir}/templates/index.html`);
    for (const name of ["language-filter.html", "icon-globe.html", "icon-sliders.html"]) {
      await Deno.copyFile(`frontend/templates/${name}`, `${dir}/templates/${name}`);
    }
    const targets = ["iOS", "macOS"].flatMap((platform) =>
      (platform === "iOS" ? [15, 16, 17, 18, 26, 27] : [12, 13, 14, 15, 26, 27])
        .map((n) => ({ platform, version: `${n}.0.1` }))
    );
    const api = async (r: Request) =>
      Response.json(
        r.url.endsWith("/catalog")
          ? { total: 2, languages: ["ja", "en"], bundles: ["/Test.app"] }
          : { url: new URL(r.url).pathname },
      );
    const app = await createReleaseWeb(targets, api, dir);
    const production = await createReleaseWeb(targets, api, dir, {
      validationOnly: false,
    });
    assert.equal(
      (await (await production(new Request("http://localhost/healthz"))).json())
        .validationOnly,
      false,
    );
    assert.equal(
      (await (await app(new Request("http://localhost/healthz"))).json())
        .validationOnly,
      true,
    );
    for (const t of targets) {
      const r = await app(
        new Request(
          `http://localhost/${t.platform.toLowerCase()}/${
            t.version.split(".")[0]
          }`,
        ),
      );
      assert.equal(r.status, 200);
      const html = await r.text();
      assert.match(html, /id="table"/);
      assert.equal((html.match(/class="bi bi-globe"/g) ?? []).length, 2);
      assert.equal((html.match(/class="bi bi-sliders"/g) ?? []).length, 1);
      assert.doesNotMatch(html, /fa-globe|fa-sliders/);
      assert.match(html, /value="Japanese"/);
      assert.deepEqual(
        [...html.matchAll(/name="language" type="checkbox" value="([^"]+)"/g)]
          .map((m) => m[1]),
        legacyOptions.map((o) => o.name),
      );
      assert.equal(
        (html.match(/href="\/(?:ios|macos)\/\d+" class="dropdown-item"/g) ?? [])
          .length,
        12,
      );
    }
    assert.match(
      await (await app(new Request("http://localhost/"))).text(),
      /for iOS 27/,
    );
    assert.equal(
      (await app(new Request("http://localhost/ios/99"))).status,
      404,
    );
    assert.equal(
      (await app(new Request("http://localhost/templates/index.html"))).status,
      404,
    );
    assert.equal(
      (await app(new Request("http://localhost/macos", { method: "POST" })))
        .status,
      405,
    );
    assert.deepEqual(
      await (await app(new Request("http://localhost/api/ios/27/search")))
        .json(),
      { url: "/api/ios/27/search" },
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
