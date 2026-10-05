import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { extractMountedImage } from "../scripts/extract-mounted-image.mjs";
import {
  assessResource,
  canonicalLanguage,
  compareTable,
  filenameEvidence,
  inspectUnlocalizedResources,
  tableIdentity,
} from "../scripts/inspect-unlocalized-resources.mjs";

test("filename locale evidence is scoped and never promoted from development language", () => {
  const imagePath =
    "/System/Library/PrivateFrameworks/SiriTTSService.framework/Versions/A/Resources/LocalizedStrings/Interstitials/ja-JP.strings";
  const data = { retry: "もう一度" };
  const assessment = assessResource({ imagePath }, data, {
    identifier: "com.apple.siri.SiriTTSService",
    developmentRegion: "en",
  });
  assert.equal(assessment.proposedLanguage, "ja-JP");
  assert.equal(assessment.acceptedLanguage, null);
  assert.equal(assessment.filenameDiffersFromDevelopmentLanguage, true);
  assert.equal(filenameEvidence(imagePath, "unrelated.bundle"), null);
  assert.equal(filenameEvidence("/Other/ja-JP.strings", null), null);
  assert.equal(canonicalLanguage("zh_HK"), "zh-HK");
  assert.equal(canonicalLanguage("English"), "en");
  assert.equal(canonicalLanguage("Base"), null);
  assert.equal(canonicalLanguage("not a locale"), null);
  const weak = assessResource(
    { imagePath: "/Other/Localizable.strings" },
    data,
    { developmentRegion: "English" },
  );
  assert.equal(weak.category, "development-language-only");
  assert.equal(weak.proposedLanguage, null);
});

test("empty tables and technical mappings are not treated as inferred English translations", () => {
  const metadata = { developmentRegion: "en" };
  assert.equal(
    assessResource({ imagePath: "/Demo.strings" }, {}, metadata).category,
    "empty",
  );
  const imagePath =
    "/System/Library/PrivateFrameworks/SFSymbols.framework/Versions/A/Resources/CoreGlyphs.bundle/Contents/Resources/name_aliases.strings";
  const assessment = assessResource({ imagePath }, { foo: "bar" }, metadata);
  assert.equal(assessment.category, "nontranslation-candidate");
  assert.equal(assessment.proposedLanguage, null);
  assert.deepEqual(assessment.samples, [{ key: "foo", target: "bar" }]);
});

test("table comparison preserves structured differences and requires nonempty complete coverage", () => {
  assert.deepEqual(
    compareTable({ a: { one: "1", other: "%d" } }, {
      a: { other: "%d", one: "1" },
    }),
    { equal: 1, different: 0, missing: 0, coversAll: true },
  );
  assert.deepEqual(
    compareTable({ a: "Open", b: "", c: "Close" }, {
      a: "Open",
      b: "different",
    }),
    { equal: 1, different: 1, missing: 1, coversAll: false },
  );
  assert.equal(compareTable({}, {}).coversAll, false);
  assert.equal(compareTable({ constructor: "test" }, {}).missing, 1);
  assert.equal(
    tableIdentity("/A.app/Resources/ja.lproj/Localizable.strings"),
    "/A.app/Resources/Localizable",
  );
  assert.notEqual(
    tableIdentity("/A.app/Resources/Localizable.strings"),
    tableIdentity("/B.app/Resources/Localizable.strings"),
  );
  assert.equal(tableIdentity("/en.lproj/nested/ja.lproj/A.strings"), null);
});

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "localization-language-test-"));
  const root = join(temp, "image"),
    input = join(temp, "scan"),
    output = join(temp, "investigation");
  const put = async (path, data) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(data));
  };
  await put("Demo.app/Contents/Info.plist", {
    CFBundleIdentifier: "demo",
    CFBundleDevelopmentRegion: "English",
  });
  await put("Demo.app/Contents/Resources/Localizable.strings", {
    Open: "Open",
    newline: "first\u2028second",
  });
  await put("Demo.app/Contents/Resources/Localizable.loctable", {
    en: { Open: "Open", newline: "first\u2028second" },
    ja: { Open: "開く", newline: "改行" },
  });
  await put("Demo.app/Contents/Resources/Other/Localizable.loctable", {
    en: { Open: "wrong" },
  });
  await put(
    "Demo.app/Contents/PlugIns/Child.appex/Contents/Resources/Unknown.strings",
    { Open: "different context" },
  );
  await put("Filter.cifilter/Contents/Info.plist", {
    CFBundleIdentifier: "filter",
    CFBundleDevelopmentRegion: "en",
  });
  await put("Filter.cifilter/Contents/Resources/Filters.strings", {
    filter: "Filter",
  });
  const decode = (bytes) => JSON.parse(bytes.toString("utf8"));
  await extractMountedImage({
    root,
    output: input,
    label: "fixture-1",
    // Inspection must preserve the original assignment of historical scans.
    bundlePolicyVersion: 4,
    decode,
    requireReadOnlyMount: false,
    minimumFreeBytes: 0,
  });
  return { temp, root, input, output, decode, put };
}

test("investigation keeps provenance, verifies hashes, bounds bundle metadata and never changes scan", async () => {
  const options = await fixture();
  const before = await readFile(join(options.input, "files.jsonl.gz"));
  const report = await inspectUnlocalizedResources(options);
  assert.equal(report.status, "inspected-not-imported");
  assert.equal(report.counts.files, 3);
  assert.equal(report.counts.errors, 0);
  const records = (await readFile(join(options.output, "files.jsonl"), "utf8"))
    .trim().split("\n").map(JSON.parse);
  const main = records.find((record) =>
    record.imagePath.endsWith("Resources/Localizable.strings")
  );
  assert.equal(
    main.assessment.category,
    "corroborated-development-language-candidate",
  );
  assert.equal(main.assessment.proposedLanguage, "en");
  assert.equal(main.assessment.acceptedLanguage, null);
  assert.equal(main.assessment.comparisons.length, 2);
  assert.ok(main.metadata.sha256);
  const child = records.find((record) =>
    record.imagePath.includes("Child.appex")
  );
  assert.equal(child.metadata, null); // Do not borrow the containing app's region.
  const filter = records.find((record) =>
    record.imagePath.includes(".cifilter")
  );
  assert.equal(filter.bundlePath, null); // Preserve original scan assignment.
  assert.equal(filter.metadata.bundlePath, "/Filter.cifilter");
  assert.deepEqual(
    await readFile(join(options.input, "files.jsonl.gz")),
    before,
  );
  await assert.rejects(inspectUnlocalizedResources(options), /EEXIST/);
  await assert.rejects(
    inspectUnlocalizedResources({
      ...options,
      output: join(options.root, "bad"),
    }),
    /outside inputs/,
  );
});

test("changed image content and symlinked metadata are inspection errors, never accepted evidence", async () => {
  const options = await fixture();
  await options.put("Demo.app/Contents/Resources/Localizable.strings", {
    changed: "resource",
  });
  await writeFile(
    join(options.temp, "outside.json"),
    JSON.stringify({ CFBundleDevelopmentRegion: "en" }),
  );
  await symlink(
    join(options.temp, "outside.json"),
    join(
      options.root,
      "Demo.app/Contents/PlugIns/Child.appex/Contents/Info.plist",
    ),
  );
  const report = await inspectUnlocalizedResources(options);
  assert.equal(report.status, "inspection-with-errors");
  assert.equal(report.counts.errors, 2);
  assert.equal(report.counts.proposedLanguageFiles, 0);
});

test("quarantine traversal is rejected even when an index is tampered with", async () => {
  const options = await fixture();
  const path = join(options.input, "files.jsonl.gz");
  const files = gunzipSync(await readFile(path)).toString().trim().split("\n")
    .map(JSON.parse);
  const file = files.find((file) => file.status === "failed");
  file.quarantinePath = "../outside.strings";
  await writeFile(
    path,
    gzipSync(files.map((file) => JSON.stringify(file)).join("\n") + "\n"),
  );
  const report = await inspectUnlocalizedResources(options);
  assert.equal(report.counts.errors, 1);
});
