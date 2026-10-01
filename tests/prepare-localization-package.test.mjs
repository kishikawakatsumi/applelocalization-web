import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { extractMountedImage } from "../scripts/extract-mounted-image.mjs";
import { inspectUnlocalizedResources } from "../scripts/inspect-unlocalized-resources.mjs";
import { extractFilenameSupplement } from "../scripts/extract-filename-localizations.mjs";
import {
  auditLocalizationPackage,
  prepareLocalizationPackage,
  tableContext,
} from "../scripts/prepare-localization-package.mjs";
import { readJsonLines, sha256 } from "../scripts/localization-jsonl.mjs";

async function fixture({ metadataProblem = false, structuredStrings = false } = {}) {
  const temp = await mkdtemp(join(tmpdir(), "localization-package-test-"));
  const root = join(temp, "image"),
    scan = join(temp, "scan"),
    inspection = join(temp, "inspection"),
    supplement = join(temp, "supplement"),
    output = join(temp, "package");
  const put = async (path, data) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(data));
  };
  for (const name of ["A", "B"]) {
    await put(`${name}.app/Contents/Resources/ja.lproj/Localizable.strings`, {
      Open: "開く",
      empty: "",
      lines: "a\u2028b\u2029c\nnext",
      nul: "\u0000",
    });
  }
  await put("A.app/Contents/Resources/en.lproj/Localizable.strings", {
    Open: "Open",
  });
  await put("A.app/Contents/Resources/ja.lproj/Other.strings", {
    Open: "開いて編集",
  });
  await put("A.app/Contents/Resources/Base.lproj/Localizable.strings", {
    Open: "Unknown language",
  });
  await put("A.app/Contents/Resources/Localizable.loctable", {
    ja: { Open: "営業中" },
    en: { Open: "Open" },
  });
  await put("A.app/Contents/Resources/ja.lproj/Counts.stringsdict", {
    count: { one: "一つ", other: "%d個" },
  });
  if (structuredStrings) {
    await put("A.app/Contents/Resources/ja.lproj/InfoPlist.strings", {
      FSPersonalities: { AFPFS: { FSName: "AppleShare" } },
      DisplayName: "共有",
    });
  }
  await put("loose/Localizable.loctable", { ja: { Open: "開く" } });
  await put("A.app/Contents/Info.plist", {
    CFBundleIdentifier: "a",
    CFBundleDevelopmentRegion: "en",
  });
  if (metadataProblem) {
    await put("B.app/Contents/Info.plist", {
      CFBundleName: "Missing identifier",
    });
  }
  await put("A.app/Contents/Resources/Unknown.strings", { unknown: "保留" });
  const siri =
    "System/Library/PrivateFrameworks/SiriTTSService.framework/Versions/A/Resources";
  await put(siri + "/Info.plist", {
    CFBundleIdentifier: "com.apple.siri.SiriTTSService",
    CFBundleDevelopmentRegion: "en",
  });
  await put(siri + "/LocalizedStrings/Interstitials/ja-JP.strings", {
    Retry: "もう一度",
  });
  await put(siri + "/LocalizedStrings/Interstitials/en-US.strings", {
    Retry: "Again",
  });
  await symlink("/nonexistent", join(root, "ignored-link"));
  const decode = (bytes) => JSON.parse(bytes.toString());
  await extractMountedImage({
    root,
    output: scan,
    label: "fixture-1",
    decode,
    requireReadOnlyMount: false,
    minimumFreeBytes: 0,
  });
  await inspectUnlocalizedResources({
    root,
    input: scan,
    output: inspection,
    decode,
  });
  await extractFilenameSupplement({
    root,
    scan,
    inspection,
    output: supplement,
    decode,
    requireReadOnlyMount: false,
  });
  return { temp, root, scan, supplement, output, decode, minimumFreeBytes: 0 };
}
const records = async (root, name) => {
  const result = [];
  for await (const row of readJsonLines(root, name + ".jsonl.gz")) {
    result.push(row);
  }
  return result;
};

test("dictionary-valued strings survive package preparation and full audit without flattening", async () => {
  const options = await fixture({ structuredStrings: true });
  const report = await prepareLocalizationPackage(options);
  assert.equal(report.counts.primaryRows, 17);
  assert.equal(report.counts.structuredRows, 2);
  const rows = await records(options.output, "occurrences");
  const row = rows.find(r => r.key === "FSPersonalities");
  assert.equal(row.targetKind, "structured");
  assert.equal(row.language, "ja");
  assert.deepEqual(row.target, { AFPFS: { FSName: "AppleShare" } });
  assert.equal(rows.some(r => r.key === "FSName"), false);
  const resources = await records(options.output, "resources");
  assert.equal(resources.find(r => r.resourceId === row.resourceId).original.imagePath, "/A.app/Contents/Resources/ja.lproj/InfoPlist.strings");
  assert.equal((await auditLocalizationPackage({ ...options, input: options.output })).status, "package-content-verified");
});

test("intermediate package preserves occurrences, table boundaries, inferred evidence, Base, structured values and originals", async () => {
  const options = await fixture();
  const before = await readFile(join(options.scan, "rows.jsonl.gz"));
  const report = await prepareLocalizationPackage(options);
  assert.equal(report.status, "prepared-not-imported");
  assert.equal(report.counts.primaryRows, 15);
  assert.equal(report.counts.supplementRows, 2);
  assert.equal(report.counts.occurrences, 17);
  assert.equal(report.counts.unresolvedFiles, 1);
  assert.equal(report.counts.structuredRows, 1);
  const resources = await records(options.output, "resources"),
    rows = await records(options.output, "occurrences"),
    tables = await records(options.output, "tables");
  assert.equal(
    rows.filter((row) => row.key === "Open" && row.target === "開く").length,
    3,
  );
  assert.equal(rows.filter((row) => row.target === "").length, 2);
  assert.equal(rows.filter((row) => row.target === "\u0000").length, 2);
  assert.ok(rows.find((row) => row.target === "a\u2028b\u2029c\nnext"));
  assert.deepEqual(rows.find((row) => row.targetKind === "structured").target, {
    one: "一つ",
    other: "%d個",
  });
  assert.equal(
    rows.find((row) => row.language === "Base").languageStatus,
    "base-unresolved",
  );
  assert.equal(
    rows.find((row) => row.language === "ja-JP").languageStatus,
    "inferred",
  );
  const find = (path) =>
    resources.find((resource) => resource.original.imagePath === path);
  const en = find("/A.app/Contents/Resources/en.lproj/Localizable.strings"),
    ja = find("/A.app/Contents/Resources/ja.lproj/Localizable.strings");
  assert.equal(en.tableId, ja.tableId);
  assert.equal(
    en.original.bundleAssignment,
    "nearest-supported-bundle-metadata",
  );
  assert.equal(en.original.bundleEvidence.metadata[0].identifier, "a");
  assert.match(en.original.bundleEvidence.metadata[0].sha256, /^[a-f0-9]{64}$/);
  assert.notEqual(
    ja.tableId,
    find("/B.app/Contents/Resources/ja.lproj/Localizable.strings").tableId,
  );
  assert.notEqual(
    ja.tableId,
    find("/A.app/Contents/Resources/Localizable.loctable").tableId,
  );
  const added = resources.filter((resource) =>
    resource.status === "supplemented-inferred"
  );
  assert.equal(added[0].tableId, added[1].tableId);
  assert.ok(
    tables.find((table) => table.tableId === added[0].tableId).basis.startsWith(
      "filename-family:",
    ),
  );
  assert.equal(
    resources.find((resource) => resource.status === "unresolved").tableId,
    null,
  );
  assert.equal((await readdir(join(options.output, "quarantine"))).length, 3);
  assert.equal((await records(options.output, "issues")).length, 3);
  assert.equal((await records(options.output, "symlinks")).length, 1);
  const catalog = JSON.parse(
    await readFile(join(options.output, "catalog.json")),
  );
  assert.equal(catalog.languages.reduce((sum, item) => sum + item.rows, 0), 17);
  assert.deepEqual(await readFile(join(options.scan, "rows.jsonl.gz")), before);
  assert.equal(
    (await auditLocalizationPackage({ ...options, input: options.output }))
      .status,
    "package-content-verified",
  );
  await assert.rejects(prepareLocalizationPackage(options), /EEXIST/);
});

test("metadata issues are preserved and accounted separately from resource failures", async () => {
  const options = await fixture({ metadataProblem: true });
  const report = await prepareLocalizationPackage(options);
  assert.equal(report.counts.occurrences, 17);
  const issues = await records(options.output, "issues");
  assert.equal(issues.length, 4);
  assert.equal(issues.filter((i) => i.stage === "bundle-metadata").length, 1);
  const resources = await records(options.output, "resources");
  assert.equal(
    resources.find((r) => r.original.bundlePath === "/B.app").original
      .bundleAssignment,
    "nearest-bundle-boundary-unresolved",
  );
  assert.equal(
    (await auditLocalizationPackage({ ...options, input: options.output }))
      .status,
    "package-content-verified",
  );
});

test("audit detects a modified occurrence even with a rewritten compressed checksum", async () => {
  const options = await fixture();
  await prepareLocalizationPackage(options);
  const rows = await records(options.output, "occurrences");
  rows[0].target = "different";
  const bytes = gzipSync(
    rows.map((row) => JSON.stringify(row) + "\n").join(""),
  );
  await writeFile(join(options.output, "occurrences.jsonl.gz"), bytes);
  const report = JSON.parse(
    await readFile(join(options.output, "report.json")),
  );
  report.outputHashes.occurrences = sha256(bytes);
  await writeFile(join(options.output, "report.json"), JSON.stringify(report));
  await assert.rejects(
    auditLocalizationPackage({ ...options, input: options.output }),
    /Content mismatch/,
  );
});

test("wrong row references or omitted primary rows cannot produce a completion report", async () => {
  const options = await fixture();
  const rows = await records(options.scan, "rows");
  rows[0].resourceId = "unknown";
  await writeFile(
    join(options.scan, "rows.jsonl.gz"),
    gzipSync(rows.map((row) => JSON.stringify(row) + "\n").join("")),
  );
  await assert.rejects(prepareLocalizationPackage(options), /no resource/);
  assert.ok(!(await readdir(options.output)).includes("report.json"));
  const other = await fixture();
  const less = (await records(other.scan, "rows")).slice(1);
  await writeFile(
    join(other.scan, "rows.jsonl.gz"),
    gzipSync(less.map((row) => JSON.stringify(row) + "\n").join("")),
  );
  await assert.rejects(prepareLocalizationPackage(other), /Row count mismatch/);
});

test("input checksum mismatch, quarantine corruption, and unsafe destinations fail closed", async () => {
  const options = await fixture();
  for (const directory of [options.scan, options.supplement]) {
    await assert.rejects(
      prepareLocalizationPackage({
        ...options,
        output: join(directory, "bad"),
      }),
      /outside inputs/,
    );
  }
  await assert.rejects(
    prepareLocalizationPackage({
      ...options,
      minimumFreeBytes: Number.MAX_SAFE_INTEGER,
    }),
    /free space/,
  );
  const files = await records(options.scan, "files");
  const file = files.find((file) => file.quarantinePath);
  await writeFile(join(options.scan, file.quarantinePath), "changed");
  await assert.rejects(prepareLocalizationPackage(options), /mismatch/);
  const other = await fixture();
  const report = JSON.parse(
    await readFile(join(other.supplement, "report.json")),
  );
  report.inputs.indexSha256 = "wrong";
  await writeFile(
    join(other.supplement, "report.json"),
    JSON.stringify(report),
  );
  await assert.rejects(prepareLocalizationPackage(other));
});

test("table identities include source, bundle, directory and format", () => {
  const file = {
    sourceId: "one",
    bundlePath: "/Demo.app",
    imagePath: "/Demo.app/A/en.lproj/X.strings",
  };
  const base = tableContext(file).tableId;
  assert.equal(
    base,
    tableContext({ ...file, imagePath: "/Demo.app/A/ja.lproj/X.strings" })
      .tableId,
  );
  for (
    const change of [{ sourceId: "two" }, {
      imagePath: "/Demo.app/B/en.lproj/X.strings",
    }, { imagePath: "/Demo.app/A/en.lproj/X.stringsdict" }]
  ) assert.notEqual(base, tableContext({ ...file, ...change }).tableId);
});

test("stream reader rejects truncated gzip and symlinked inputs", async () => {
  const temp = await mkdtemp(join(tmpdir(), "localization-stream-test-"));
  const bytes = gzipSync(JSON.stringify({ text: "a\u2028b\u2029c" }) + "\n");
  await writeFile(join(temp, "complete.jsonl.gz"), bytes);
  assert.deepEqual(await records(temp, "complete"), [{
    text: "a\u2028b\u2029c",
  }]);
  await writeFile(
    join(temp, "truncated.jsonl.gz"),
    bytes.subarray(0, bytes.length - 8),
  );
  await assert.rejects(records(temp, "truncated"));
  await symlink(join(temp, "complete.jsonl.gz"), join(temp, "link.jsonl.gz"));
  await assert.rejects(records(temp, "link"), /regular file/);
});
