import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { extractMountedImage } from "../../scripts/extraction/extract-mounted-image.mjs";
import { verifyReassignment } from "../../scripts/package/verify-bundle-reassignment.mjs";
import { readJsonLines } from "../../scripts/shared/localization-jsonl.mjs";

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "bundle-reassignment-"));
  const root = join(temp, "image");
  const directory = join(root, "Finder.app/Shared.cannedSearch/Resources");
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, "Info.plist"),
    JSON.stringify({ CFBundleIdentifier: "com.apple.shared" }),
  );
  await writeFile(
    join(directory, "A.loctable"),
    JSON.stringify({
      ja: { Open: "開く", empty: "", nul: "\0", plural: { one: "1" } },
      en: { Open: "Open" },
    }),
  );
  const options = {
    root,
    label: "fixture",
    minimumFreeBytes: 0,
    requireReadOnlyMount: false,
    decode: (bytes) => JSON.parse(bytes),
  };
  const baseline = join(temp, "old"), candidate = join(temp, "new");
  // Fixture baseline emulates only the old ownership fields, retaining actual bytes and rows.
  await extractMountedImage({ ...options, output: baseline });
  const files = [];
  for await (const f of readJsonLines(baseline, "files.jsonl.gz")) {
    f.bundlePath = "/Finder.app";
    f.bundleName = "Finder.app";
    f.resourcePath = "Shared.cannedSearch/Resources/A.loctable";
    f.tablePath = f.resourcePath;
    f.bundleAssignment = "nearest-known-bundle-extension";
    delete f.bundleEvidence;
    files.push(f);
  }
  await writeFile(
    join(baseline, "files.jsonl.gz"),
    gzipSync(files.map((f) => JSON.stringify(f) + "\n").join("")),
  );
  await extractMountedImage({
    ...options,
    output: candidate,
    subtree: "Finder.app",
  });
  return { baseline, candidate, root };
}
test("reassignment audit preserves every row and distinguishes ownership from value changes", async () => {
  const f = await fixture();
  const report = await verifyReassignment(f);
  assert.equal(report.counts.rows, 5);
  assert.equal(report.counts.changedBundleResources, 1);
  assert.equal(report.counts.verifiedMetadataFiles, 1);
  assert.equal(report.changes[0].oldBundlePath, "/Finder.app");
  assert.equal(
    report.changes[0].newBundlePath,
    "/Finder.app/Shared.cannedSearch",
  );
  const rows = [];
  for await (const row of readJsonLines(f.candidate, "rows.jsonl.gz")) {
    rows.push(row);
  }
  rows[0].target = "changed";
  await writeFile(
    join(f.candidate, "rows.jsonl.gz"),
    gzipSync(rows.map((r) => JSON.stringify(r) + "\n").join("")),
  );
  await assert.rejects(verifyReassignment(f), /Changed row values/);
});
test("reassignment audit refuses changed evidence or a different image source", async () => {
  const f = await fixture();
  await writeFile(
    join(f.root, "Finder.app/Shared.cannedSearch/Resources/Info.plist"),
    "changed",
  );
  await assert.rejects(verifyReassignment(f));
  const report = JSON.parse(await readFile(join(f.candidate, "report.json")));
  report.source.sourceId = "another";
  await writeFile(join(f.candidate, "report.json"), JSON.stringify(report));
  await assert.rejects(verifyReassignment(f));
});

test("whole-image comparison accounts for all resources and distinguishes decoder retries from content changes", async () => {
  const f = await fixture();
  const path = join(f.candidate, "report.json");
  const report = JSON.parse(await readFile(path));
  report.source.scope = { kind: "whole-image" };
  await writeFile(path, JSON.stringify(report));
  const files = [];
  for await (const file of readJsonLines(f.candidate, "files.jsonl.gz")) {
    files.push({ ...file, decodeAttempts: 2, retryReason: "ETIMEDOUT" });
  }
  await writeFile(
    join(f.candidate, "files.jsonl.gz"),
    gzipSync(files.map((f) => JSON.stringify(f) + "\n").join("")),
  );
  const result = await verifyReassignment(f);
  assert.equal(result.scopeKind, "whole-image");
  assert.equal(result.counts.rows, 5);
  assert.equal(result.operationalDifferences.length, 1);
  const baseline = JSON.parse(await readFile(join(f.baseline, "report.json")));
  baseline.source.scope = { kind: "subtree", imagePath: "/Finder.app" };
  await writeFile(join(f.baseline, "report.json"), JSON.stringify(baseline));
  await assert.rejects(verifyReassignment(f), /whole-image baseline/);
});
