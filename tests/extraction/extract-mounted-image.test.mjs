import test from "node:test";
import process from "node:process";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import {
  extractMountedImage,
  resourceContext,
} from "../../scripts/extraction/extract-mounted-image.mjs";

const lines = async (path) =>
  gunzipSync(await readFile(path)).toString("utf8").split("\n").filter(Boolean)
    .map((line) => JSON.parse(line));
async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "localization-image-test-"));
  const root = join(temp, "image");
  await mkdir(root);
  const put = async (path, data) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(
      join(root, path),
      typeof data === "string" ? data : JSON.stringify(data),
    );
  };
  return {
    temp,
    root,
    put,
    options: {
      root,
      output: join(temp, "output"),
      label: "fixture-image-1",
      requireReadOnlyMount: false,
      minimumFreeBytes: 0,
      decode: (bytes) => JSON.parse(bytes.toString("utf8")),
    },
  };
}

const projection = {
  version: "15.8.1",
  build: "24H32",
  archiveSha256: "a".repeat(64),
  extractionReportSha256: "b".repeat(64),
  auditSha256: "c".repeat(64),
};

test("installer projection preserves real paths and rows without claiming whole-image scope", async () => {
  const { put, options } = await fixture();
  await put("Test.app/ja.lproj/A.strings", { Open: "開く" });
  const report = await extractMountedImage({
    ...options,
    installerProjection: projection,
  });
  assert.deepEqual(report.source.scope, {
    kind: "installer-resource-projection",
    ...projection,
  });
  assert.match(report.limitations[0], /not a complete OS image/);
  const files = await lines(join(options.output, "files.jsonl.gz"));
  assert.equal(files[0].imagePath, "/Test.app/ja.lproj/A.strings");
  assert.equal(files[0].bundlePath, "/Test.app");
  assert.equal(report.counts.rows, 1);
});

test("installer scope cannot bypass mount checks or accept ambiguous provenance", async () => {
  const { options } = await fixture();
  for (
    const overrides of [
      { requireReadOnlyMount: true },
      { subtree: "Test.app" },
      { installerProjection: { ...projection, archiveSha256: "bad" } },
      { installerProjection: { ...projection, version: "" } },
    ]
  ) {
    await assert.rejects(
      extractMountedImage({
        ...options,
        installerProjection: projection,
        ...overrides,
      }),
      /Invalid installer projection/,
    );
  }
});

test("whole-image scan includes nested bundles and unbundled resources, preserving equal and different translations", async () => {
  const { put, options } = await fixture();
  await put("System/Demo.app/Resources/ja.lproj/A.strings", {
    Open: "開く",
    empty: "",
  });
  await put("System/Demo.app/Resources/ja.lproj/B.strings", { Open: "開く" });
  await put("System/Demo.app/PlugIns/Editor.appex/ja.lproj/A.strings", {
    Open: "開いて編集",
  });
  await put("usr/libexec/Agent/Messages.loctable", {
    en: { Open: "Open" },
    ja: { Open: "開く", plural: { one: "1個", other: "%d個" } },
  });
  const report = await extractMountedImage(options);
  assert.equal(report.status, "complete-within-scope");
  assert.equal(report.counts.rows, 7);
  assert.equal(report.counts.unbundledFiles, 1);
  assert.equal(report.counts.structuredRows, 1);
  assert.deepEqual(report.bundlePaths, [
    "/System/Demo.app",
    "/System/Demo.app/PlugIns/Editor.appex",
  ]);
  const files = await lines(join(options.output, "files.jsonl.gz"));
  const rows = await lines(join(options.output, "rows.jsonl.gz"));
  const byId = new Map(files.map((file) => [file.resourceId, file]));
  assert.equal(
    rows.filter((r) => r.key === "Open" && r.target === "開く").length,
    3,
  );
  assert.equal(
    byId.get(rows.find((r) => r.target === "開いて編集").resourceId).bundlePath,
    "/System/Demo.app/PlugIns/Editor.appex",
  );
  assert.equal(
    byId.get(rows.find((r) => r.language === "en").resourceId).bundlePath,
    null,
  );
  assert.deepEqual(rows.find((r) => r.targetKind === "structured").target, {
    one: "1個",
    other: "%d個",
  });
  assert.equal(rows.filter((r) => r.target === "").length, 1);
  assert.equal(new Set(files.map((f) => f.resourceId)).size, 4);
  await assert.rejects(extractMountedImage(options), /EEXIST/);
});

test("links are not followed; language-unknown and malformed files are quarantined, not silently dropped", async () => {
  const { temp, root, put, options } = await fixture();
  await put("usr/libexec/Agent/Localizable.strings", {
    key: "unknown language",
  });
  await put("System/Bad.loctable", "broken");
  await put("System/Good.loctable", { ja: { key: "正しい" } });
  await symlink(temp, join(root, "outside"));
  const report = await extractMountedImage(options);
  assert.equal(report.status, "scanned-with-issues");
  assert.equal(report.counts.failedFiles, 2);
  assert.equal(report.counts.quarantinedFiles, 2);
  assert.equal(report.counts.rows, 1);
  assert.equal(report.counts.symlinks, 1);
  const files = await lines(join(options.output, "files.jsonl.gz"));
  const bad = files.find((f) => f.imagePath === "/System/Bad.loctable");
  assert.equal(
    await readFile(join(options.output, bad.quarantinePath), "utf8"),
    "broken",
  );
  assert.equal(
    (await lines(join(options.output, "issues.jsonl.gz"))).length,
    2,
  );
  const audit = (name) =>
    spawnSync(process.execPath, [
      "scripts/extraction/audit-image-extraction.mjs",
      "--input",
      options.output,
      "--output",
      join(temp, name),
    ], { encoding: "utf8", timeout: 10000 });
  assert.equal(audit("audit.json").status, 0);
  await writeFile(join(options.output, bad.quarantinePath), "changed");
  assert.notEqual(audit("invalid-audit.json").status, 0);
});

test("source identity distinguishes the same path in different images", () => {
  const first = resourceContext("/usr/Agent/A.loctable", null, "image1");
  const second = resourceContext("/usr/Agent/A.loctable", null, "image2");
  assert.notEqual(first.resourceId, second.resourceId);
  assert.equal(first.resourcePath, "usr/Agent/A.loctable");
  assert.equal(first.bundlePath, null);
});

test("a transient decoder timeout is retried once without duplicate rows", async () => {
  const { put, options } = await fixture();
  await put("System/A.loctable", { ja: { name: "名前" } });
  let attempts = 0;
  const report = await extractMountedImage({
    ...options,
    decode: (bytes) => {
      if (++attempts === 1) {
        throw Object.assign(new Error("timeout"), { code: "ETIMEDOUT" });
      }
      return JSON.parse(bytes.toString("utf8"));
    },
  });
  assert.equal(report.counts.decodeRetries, 1);
  assert.equal(report.counts.rows, 1);
  assert.equal(report.counts.failedFiles, 0);
  const files = await lines(join(options.output, "files.jsonl.gz"));
  assert.equal(files[0].decodeAttempts, 2);
});

test("safety guards reject host root, output within input, and insufficient space", async () => {
  const { root, put, options } = await fixture();
  await put("System/A.loctable", { en: { key: "test" } });
  await assert.rejects(
    extractMountedImage({ ...options, root: "/" }),
    /host root/,
  );
  await assert.rejects(
    extractMountedImage({ ...options, output: join(root, "output") }),
    /outside/,
  );
  await assert.rejects(
    extractMountedImage({
      ...options,
      minimumFreeBytes: Number.MAX_SAFE_INTEGER,
    }),
    /Free space/,
  );
  const report = JSON.parse(
    await readFile(join(options.output, "report.json"), "utf8"),
  );
  assert.equal(report.status, "aborted");
  assert.equal(report.counts.resourceFiles, 0);
});

test("streaming auditor verifies provenance and variants, and rejects inconsistent totals", async () => {
  const { temp, put, options } = await fixture();
  await put("System/A.app/Messages.loctable", { ja: { Open: "開く" } });
  await put("usr/Agent/Messages.loctable", {
    ja: { Open: "開いて\u2028編集\u2029する\n次の行\r\n終わり" },
  });
  const report = await extractMountedImage(options);
  const run = (output) =>
    spawnSync(process.execPath, [
      "scripts/extraction/audit-image-extraction.mjs",
      "--input",
      options.output,
      "--output",
      output,
    ], { encoding: "utf8", timeout: 10000 });
  const output = join(temp, "audit.json");
  const success = run(output);
  assert.equal(success.status, 0, success.stderr);
  const audit = JSON.parse(await readFile(output, "utf8"));
  assert.equal(audit.counts.rows, 2);
  assert.equal(audit.illustrativeJapaneseVariants[0].targets.length, 2);
  assert.equal(
    audit.illustrativeJapaneseVariants[0].targets[1].target,
    "開いて\u2028編集\u2029する\n次の行\r\n終わり",
  );
  assert.equal(audit.outsideOldMacOSRoots.length, 1);
  assert.notEqual(run(output).status, 0);
  report.counts.rows++;
  await writeFile(join(options.output, "report.json"), JSON.stringify(report));
  assert.notEqual(run(join(temp, "bad-audit.json")).status, 0);
});

test("metadata-backed nested bundle retains evidence without promoting its Resources directory", async () => {
  const { put, options } = await fixture();
  await put("Finder.app/Contents/Info.plist", {
    CFBundleIdentifier: "com.apple.finder",
  });
  await put(
    "Finder.app/Contents/Resources/Shared.cannedSearch/Resources/Info.plist",
    { CFBundleIdentifier: "com.apple.shared", CFBundleDevelopmentRegion: "en" },
  );
  await put(
    "Finder.app/Contents/Resources/Shared.cannedSearch/Resources/InfoPlist.loctable",
    {
      ja: { name: "共有", empty: "", plural: { one: "一つ" } },
      en: { name: "Shared" },
    },
  );
  await put("Finder.app/Contents/Resources/ordinary/Info.plist", {
    CFBundleIdentifier: "not.a.bundle",
  });
  await put("Finder.app/Contents/Resources/ordinary/Text.loctable", {
    ja: { name: "親" },
  });
  const report = await extractMountedImage(options);
  assert.equal(report.status, "complete-within-scope");
  const files = await lines(join(options.output, "files.jsonl.gz"));
  const nested = files.find((f) => f.imagePath.includes("Shared.cannedSearch"));
  assert.equal(
    nested.bundlePath,
    "/Finder.app/Contents/Resources/Shared.cannedSearch",
  );
  assert.equal(nested.resourcePath, "Resources/InfoPlist.loctable");
  assert.equal(nested.bundleAssignment, "nearest-supported-bundle-metadata");
  assert.equal(
    nested.bundleEvidence.metadata[0].identifier,
    "com.apple.shared",
  );
  assert.match(nested.bundleEvidence.metadata[0].sha256, /^[a-f0-9]{64}$/);
  assert.equal(
    files.find((f) => f.imagePath.includes("/ordinary/")).bundlePath,
    "/Finder.app",
  );
  assert.equal(report.counts.rows, 5);
});

test("missing, invalid and conflicting metadata cannot promote a new bundle type", async () => {
  const { put, options } = await fixture();
  for (const name of ["Missing", "Invalid", "Conflict"]) {
    await put(`Parent.app/${name}.cannedSearch/Resources/Text.loctable`, {
      ja: { name: name },
    });
  }
  await put("Parent.app/Invalid.cannedSearch/Resources/Info.plist", {
    CFBundleDevelopmentRegion: "en",
  });
  await put("Parent.app/Conflict.cannedSearch/Info.plist", {
    CFBundleIdentifier: "one",
  });
  await put("Parent.app/Conflict.cannedSearch/Resources/Info.plist", {
    CFBundleIdentifier: "two",
  });
  await put("Parent.app/NoLanguage.cannedSearch/Resources/Info.plist", {
    CFBundleIdentifier: "valid",
    CFBundleDevelopmentRegion: "en",
  });
  await put(
    "Parent.app/NoLanguage.cannedSearch/Resources/Localizable.strings",
    { name: "Not automatically English" },
  );
  const report = await extractMountedImage(options);
  assert.equal(report.status, "scanned-with-issues");
  assert.equal(report.counts.bundleMetadataIssues, 3);
  const files = await lines(join(options.output, "files.jsonl.gz"));
  for (const f of files.filter((f) => !f.imagePath.includes("NoLanguage"))) {
    assert.equal(f.bundlePath, "/Parent.app");
  }
  assert.equal(
    files.find((f) => f.imagePath.includes("NoLanguage")).status,
    "failed",
  );
  assert.equal(report.counts.rows, 3);
});

test("metadata links and oversized files are refused without following outside the image", async () => {
  const { temp, root, put, options } = await fixture();
  await writeFile(
    join(temp, "external.plist"),
    JSON.stringify({ CFBundleIdentifier: "external" }),
  );
  for (const name of ["Link", "Large"]) {
    await put(`Parent.app/${name}.cannedSearch/Resources/Text.loctable`, {
      ja: { name },
    });
  }
  await symlink(
    join(temp, "external.plist"),
    join(root, "Parent.app/Link.cannedSearch/Resources/Info.plist"),
  );
  await put(
    "Parent.app/Large.cannedSearch/Resources/Info.plist",
    "x".repeat(2 * 1024 * 1024 + 1),
  );
  const report = await extractMountedImage(options);
  assert.equal(report.counts.bundleMetadataIssues, 2);
  for (const f of await lines(join(options.output, "files.jsonl.gz"))) {
    assert.equal(f.bundlePath, "/Parent.app");
  }
  const audit = spawnSync(process.execPath, [
    "scripts/extraction/audit-image-extraction.mjs",
    "--input",
    options.output,
    "--output",
    join(temp, "audit.json"),
  ], { encoding: "utf8" });
  assert.equal(audit.status, 0, audit.stderr);
});

test("subtree scan preserves image paths, inherited ownership, resource IDs and all row values", async () => {
  const { temp, put, options } = await fixture();
  await put("Parent.app/Contents/Info.plist", { CFBundleIdentifier: "parent" });
  await put("Parent.app/Contents/Resources/A.loctable", {
    ja: { Open: "開く", empty: "", nul: "\0" },
  });
  await put("Outside.app/A.loctable", { en: { Open: "Open" } });
  await extractMountedImage(options);
  const sub = {
    ...options,
    output: join(temp, "subtree"),
    subtree: "Parent.app/Contents/Resources",
  };
  const report = await extractMountedImage(sub);
  assert.deepEqual(report.source.scope, {
    kind: "subtree",
    imagePath: "/Parent.app/Contents/Resources",
  });
  const full = await lines(join(options.output, "files.jsonl.gz")),
    files = await lines(join(sub.output, "files.jsonl.gz"));
  assert.deepEqual(files, [full.find((f) => f.bundlePath === "/Parent.app")]);
  const fullRows = await lines(join(options.output, "rows.jsonl.gz"));
  assert.deepEqual(
    await lines(join(sub.output, "rows.jsonl.gz")),
    fullRows.filter((r) => r.resourceId === files[0].resourceId),
  );
});

test("subtree traversal and symlink ancestors are refused before creating output", async () => {
  const { temp, root, options } = await fixture();
  await symlink(temp, join(root, "escape"));
  for (
    const subtree of ["/absolute", "../escape", "a/../b", "a//b", "escape"]
  ) {
    await assert.rejects(
      extractMountedImage({ ...options, subtree }),
      /subtree|Subtree/,
    );
  }
  await assert.rejects(readFile(join(options.output, "report.json")), /ENOENT/);
});
