import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { extractMountedImage } from "../../scripts/extraction/extract-mounted-image.mjs";
import { inspectUnlocalizedResources } from "../../scripts/extraction/inspect-unlocalized-resources.mjs";
import {
  auditFilenameSupplement,
  extractFilenameSupplement,
} from "../../scripts/extraction/extract-filename-localizations.mjs";

const siri =
  "System/Library/PrivateFrameworks/SiriTTSService.framework/Versions/A/Resources";
const lines = async (directory, name) =>
  gunzipSync(await readFile(join(directory, name + ".jsonl.gz"))).toString()
    .split("\n").filter(Boolean).map(JSON.parse);
async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "filename-supplement-test-"));
  const root = join(temp, "image"),
    scan = join(temp, "scan"),
    inspection = join(temp, "inspection"),
    output = join(temp, "supplement");
  const put = async (path, data) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(data));
  };
  await put(siri + "/Info.plist", {
    CFBundleIdentifier: "com.apple.siri.SiriTTSService",
    CFBundleDevelopmentRegion: "en",
  });
  await put(siri + "/LocalizedStrings/Interstitials/ja-JP.strings", {
    Open: "開く",
    empty: "",
    line: "a\u2028b\u2029c\nnext",
  });
  await put(siri + "/LocalizedStrings/Interstitials/en-US.strings", {
    Open: "Open",
  });
  await put(siri + "/LocalizedStrings/Interstitials/en_US.strings", {
    Open: "Open differently",
  });
  await put(siri + "/Localizable.strings", { Open: "Do not infer English" });
  await put(siri + "/Empty.strings", {});
  await put(siri + "/ja.lproj/Localizable.strings", { Open: "既存" });
  for (
    const path of [
      "PrivateFrameworks/CoreChineseEngine.framework",
      "TextInput/TextInput_zh.bundle",
    ]
  ) {
    const resources = "System/Library/" + path + "/Versions/A/Resources";
    await put(resources + "/Info.plist", {
      CFBundleIdentifier: path,
      CFBundleDevelopmentRegion: "en",
    });
    await put(resources + "/CIMPunctuationDescription_zh_Hant.strings", {
      period: "句點",
    });
  }
  const decode = (bytes) => JSON.parse(bytes.toString());
  await extractMountedImage({
    root,
    output: scan,
    label: "fixture-source",
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
  return {
    temp,
    put,
    root,
    scan,
    inspection,
    output,
    decode,
    requireReadOnlyMount: false,
  };
}

test("supplement preserves all occurrences, locale variants, exact text and context, without modifying inputs", async () => {
  const options = await fixture();
  const before = await readFile(join(options.scan, "files.jsonl.gz"));
  const inspectionBefore = await readFile(
    join(options.inspection, "files.jsonl"),
  );
  const report = await extractFilenameSupplement(options);
  assert.deepEqual(report.counts, {
    inspectedFiles: 7,
    extractedFiles: 5,
    rows: 7,
    textRows: 7,
    structuredRows: 0,
    deferredFiles: 2,
  });
  const files = await lines(options.output, "files"),
    rows = await lines(options.output, "rows");
  const aliases = rows.filter((row) => row.language === "en-US");
  assert.equal(aliases.length, 2);
  assert.notEqual(aliases[0].resourceId, aliases[1].resourceId);
  assert.deepEqual(
    new Set(aliases.map((row) => row.languageRaw)),
    new Set(["en-US", "en_US"]),
  );
  assert.deepEqual(
    new Set(aliases.map((row) => row.target)),
    new Set(["Open", "Open differently"]),
  );
  assert.equal(rows.filter((row) => row.target === "句點").length, 2);
  assert.equal(rows.find((row) => row.key === "empty").target, "");
  assert.equal(
    rows.find((row) => row.key === "line").target,
    "a\u2028b\u2029c\nnext",
  );
  for (const row of rows) {
    assert.equal(row.languageBasis, "filename-convention");
    assert.equal(row.languageStatus, "inferred");
    const file = files.find((file) => file.resourceId === row.resourceId);
    assert.ok(file.bundlePath && file.imagePath && file.quarantinePath);
    assert.equal(file.languageEvidence.resourceSha256, file.sha256);
    assert.ok(file.languageEvidence.metadata.sha256);
    assert.equal(file.originalScanStatus, "failed");
  }
  assert.deepEqual(
    await readFile(join(options.scan, "files.jsonl.gz")),
    before,
  );
  assert.deepEqual(
    await readFile(join(options.inspection, "files.jsonl")),
    inspectionBefore,
  );
  const audit = await auditFilenameSupplement({
    ...options,
    input: options.output,
  });
  assert.equal(audit.status, "supplement-content-verified");
  await assert.rejects(extractFilenameSupplement(options), /EEXIST/);
  for (const parent of [options.root, options.scan, options.inspection]) {
    await assert.rejects(
      extractFilenameSupplement({ ...options, output: join(parent, "bad") }),
      /outside inputs/,
    );
  }
});

test("audit rejects changed rows even if the output checksum is recomputed", async () => {
  const options = await fixture();
  await extractFilenameSupplement(options);
  const rows = await lines(options.output, "rows");
  rows[0].target = "tampered";
  const bytes = gzipSync(
    rows.map((row) => JSON.stringify(row) + "\n").join(""),
  );
  await writeFile(join(options.output, "rows.jsonl.gz"), bytes);
  const report = JSON.parse(
    await readFile(join(options.output, "report.json")),
  );
  report.outputHashes.rows = createHash("sha256").update(bytes).digest("hex");
  await writeFile(join(options.output, "report.json"), JSON.stringify(report));
  await assert.rejects(
    auditFilenameSupplement({ ...options, input: options.output }),
    /Original-content mismatch/,
  );
});

test("changed metadata or resource bytes are rejected before output is created", async () => {
  const options = await fixture();
  await options.put(siri + "/Info.plist", { CFBundleIdentifier: "different" });
  await assert.rejects(extractFilenameSupplement(options), /metadata changed/);
  assert.ok(!(await readdir(options.temp)).includes("supplement"));
  const other = await fixture();
  await other.put(siri + "/LocalizedStrings/Interstitials/ja-JP.strings", {
    bad: "different",
  });
  await assert.rejects(extractFilenameSupplement(other), /mismatch/);
  assert.ok(!(await readdir(other.temp)).includes("supplement"));
});

test("altered classification and omitted inspected files cannot silently broaden or shrink extraction", async () => {
  const options = await fixture();
  const path = join(options.inspection, "files.jsonl");
  const records = (await readFile(path, "utf8")).trim().split("\n").map(
    JSON.parse,
  );
  const changed = structuredClone(records);
  changed.find((file) =>
    file.assessment.category === "development-language-only"
  ).assessment.category = "filename-language-candidate";
  await writeFile(
    path,
    changed.map((file) => JSON.stringify(file) + "\n").join(""),
  );
  await assert.rejects(
    extractFilenameSupplement(options),
    /classification changed/,
  );
  await writeFile(
    path,
    records.slice(1).map((file) => JSON.stringify(file) + "\n").join(""),
  );
  await assert.rejects(extractFilenameSupplement(options));
});

test("read-only mount is required by default and input symlinks are refused", async () => {
  const options = await fixture();
  if (process.platform === "darwin") {
    await assert.rejects(
      extractFilenameSupplement({ ...options, requireReadOnlyMount: true }),
      /read-only mount/,
    );
  }
  const records =
    (await readFile(join(options.inspection, "files.jsonl"), "utf8")).trim()
      .split("\n").map(JSON.parse);
  const target = records.find((file) =>
    file.assessment.category === "filename-language-candidate"
  );
  const link = "quarantine/" + "a".repeat(64) + ".strings";
  await symlink(
    join(options.scan, target.quarantinePath),
    join(options.scan, link),
  );
  // Directly check the shared guard to avoid changing the index/inspection evidence.
  const { safeRead } = await import(
    "../../scripts/extraction/inspect-unlocalized-resources.mjs"
  );
  await assert.rejects(safeRead(options.scan, link), /Symlink/);
});
