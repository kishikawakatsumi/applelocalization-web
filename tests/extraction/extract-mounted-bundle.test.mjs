import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  decodePlist,
  extractMountedBundle,
  resourceRows,
} from "../../scripts/extraction/extract-mounted-bundle.mjs";

test("loctable retains language codes and structured targets; provenance is not a language", () => {
  const rows = resourceRows({
    LocProvenance: { ja: 1 },
    en: { name: "Name" },
    ja: { name: "名前", plural: { one: "1個" } },
  }, "Resources/Names.loctable");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find((row) => row.key === "plural").target, {
    one: "1個",
  });
  assert.equal(
    rows.find((row) => row.key === "plural").targetKind,
    "structured",
  );
  assert.equal(rows[0].tablePath, "Resources/Names.loctable");
  assert.throws(() => resourceRows({ ja: false }, "Bad.loctable"));
  assert.throws(() => resourceRows({ ja: { key: 42 } }, "Bad.loctable"));
});

test("localized tables align without merging same-named tables from different subdirectories", () => {
  const row = (path) => resourceRows({ key: "value" }, path)[0];
  assert.equal(
    row("Resources/en.lproj/A/Localizable.strings").tablePath,
    row("Resources/ja.lproj/A/Localizable.strings").tablePath,
  );
  assert.notEqual(
    row("Resources/en.lproj/A/Localizable.strings").tablePath,
    row("Resources/en.lproj/B/Localizable.strings").tablePath,
  );
  assert.equal(row("Resources/Base.lproj/A.strings").language, "Base");
  assert.equal(
    row("Resources/ja~iphone.lproj/A.strings").language,
    "ja~iphone",
  );
  assert.throws(
    () => row("Resources/Localizable.strings"),
    /refusing to guess/,
  );
  assert.throws(() => row("en.lproj/ja.lproj/A.strings"));
  assert.equal(resourceRows({ key: {} }, "en.lproj/A.strings")[0].targetKind, "structured");
  assert.deepEqual(
    resourceRows(
      { count: { NSStringLocalizedFormatKey: "%#@count@" } },
      "en.lproj/A.stringsdict",
    )[0].target,
    { NSStringLocalizedFormatKey: "%#@count@" },
  );
});

test("dictionary-valued strings preserve nested context alongside ordinary strings, never flatten or guess language", () => {
  const target = { AFPFS: { FSName: "AppleShare", variants: ["", "\u0000", { enabled: true }] } };
  const rows = resourceRows({ FSPersonalities: target, Name: "共有", empty: "" }, "ja.lproj/InfoPlist.strings");
  assert.equal(rows.length, 3);
  assert.deepEqual(rows.find(r => r.key === "FSPersonalities").target, target);
  assert.equal(rows.find(r => r.key === "FSPersonalities").targetKind, "structured");
  assert.equal(rows.find(r => r.key === "Name").targetKind, "text");
  assert.ok(rows.every(r => r.language === "ja" && r.format === "strings"));
  assert.equal(rows.some(r => r.key === "FSName"), false);
  for (const invalid of [[], null, true, 1]) {
    assert.throws(() => resourceRows({ Name: "valid", bad: invalid }, "ja.lproj/InfoPlist.strings"), /Unsupported target type/);
  }
  assert.throws(() => resourceRows({ FSPersonalities: target }, "InfoPlist.strings"), /refusing to guess language/);
});

test("macOS plist decoder handles XML, binary and UTF-16 OpenStep strings", {
  skip: process.platform !== "darwin",
}, () => {
  const xml = Buffer.from(
    '<?xml version="1.0"?><plist version="1.0"><dict><key>key</key><string>名前</string></dict></plist>',
  );
  assert.deepEqual(decodePlist(xml), { key: "名前" });
  const binary = spawnSync("/usr/bin/plutil", [
    "-convert",
    "binary1",
    "-o",
    "-",
    "--",
    "-",
  ], { input: xml });
  assert.equal(binary.status, 0);
  assert.deepEqual(decodePlist(binary.stdout), { key: "名前" });
  assert.deepEqual(
    decodePlist(Buffer.from('\ufeff"key" = "名前";', "utf16le")),
    { key: "名前" },
  );
  assert.throws(() => decodePlist(Buffer.from("broken")));
});

test(
  "single-bundle extraction records errors, skips links/nested bundles and refuses overwrites",
  { skip: process.platform !== "darwin" },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "localization-mount-test-"));
    const root = join(temp, "root");
    const bundle = "System/Library/Frameworks/Demo.framework";
    const source = join(root, bundle);
    await mkdir(join(source, "Resources/en.lproj"), { recursive: true });
    await mkdir(join(source, "Nested.bundle"));
    await writeFile(
      join(source, "Resources/en.lproj/A.strings"),
      '"key" = "Hello";',
    );
    await writeFile(join(source, "Nested.bundle/ignored.loctable"), "invalid");
    await symlink("Resources", join(source, "Alias"));
    await symlink(temp, join(source, "Outside"));
    const options = {
      root,
      bundle,
      output: join(temp, "first"),
      kind: "fixture",
      label: "test",
    };
    const report = await extractMountedBundle(options);
    assert.equal(report.status, "complete-within-scope");
    assert.equal(report.counts.textRows, 1);
    assert.equal(report.files[0].sha256.length, 64);
    assert.equal(report.exclusions.length, 3);
    const row = JSON.parse(
      (await readFile(join(options.output, "rows.jsonl"), "utf8")).trim(),
    );
    assert.equal(row.bundlePath, "/" + bundle);
    assert.equal(row.target, "Hello");
    await assert.rejects(extractMountedBundle(options), /EEXIST/);
    await assert.rejects(
      extractMountedBundle({ ...options, output: join(source, "output") }),
      /inside/,
    );
    await assert.rejects(
      extractMountedBundle({ ...options, bundle: "../outside" }),
      /root-relative/,
    );
    await symlink(source, join(root, "Linked.framework"));
    await assert.rejects(
      extractMountedBundle({ ...options, bundle: "Linked.framework" }),
      /physical directory/,
    );
    await writeFile(join(source, "Resources/en.lproj/B.strings"), "broken");
    const failed = await extractMountedBundle({
      ...options,
      output: join(temp, "second"),
    });
    assert.equal(failed.status, "incomplete");
    assert.equal(failed.errors.length, 1);
    assert.equal(failed.counts.textRows, 1);
    await mkdir(join(root, "Empty.framework"));
    const empty = await extractMountedBundle({
      ...options,
      bundle: "Empty.framework",
      output: join(temp, "empty"),
    });
    assert.equal(empty.status, "incomplete");
  },
);
