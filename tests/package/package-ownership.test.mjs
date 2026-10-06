import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { packageOwnership } from "../../scripts/package/package-ownership.mjs";
import { bundlePolicies } from "../../scripts/package/bundle-assignment.mjs";
import { sha256 } from "../../scripts/shared/localization-jsonl.mjs";

async function fixture(mutate = () => {}) {
  const directory = await mkdtemp(join(tmpdir(), "ownership-input-test-"));
  const file = {
    resourceId: "resource",
    sourceId: "source",
    imagePath: "/Theme.pptheme/ja.lproj/A.strings",
    bundlePath: null,
    resourcePath: "Theme.pptheme/ja.lproj/A.strings",
    bundleAssignment: "unbundled",
    sha256: "a".repeat(64),
    status: "parsed",
    rows: 2,
  };
  const change = {
    resourceId: file.resourceId,
    sourceId: file.sourceId,
    imagePath: file.imagePath,
    resourceSha256: file.sha256,
    before: {
      bundlePath: null,
      resourcePath: file.resourcePath,
      assignment: "unbundled",
    },
    after: {
      bundlePath: "/Theme.pptheme",
      resourcePath: "ja.lproj/A.strings",
      assignment: "nearest-supported-bundle-metadata",
      evidence: {
        version: 5,
        bundlePath: "/Theme.pptheme",
        extension: ".pptheme",
        method: "allowlisted-extension-and-info-plist",
        problems: [],
        metadata: [{
          imagePath: "/Theme.pptheme/Contents/Info.plist",
          identifier: "test.theme",
          sha256: "b".repeat(64),
          bytes: 200,
        }],
      },
    },
    indexedRows: 2,
  };
  const report = {
    status: "verified-ownership-overlay-not-applied",
    formatVersion: 1,
    sourceId: "source",
    policy: structuredClone(bundlePolicies[5]),
    inputHashes: {
      scanReport: "scan",
      index: "index",
      extraction: "extraction",
    },
    counts: {
      files: 1,
      changedFiles: 1,
      previouslyUnbundled: 1,
      nestedBoundaryChanges: 0,
      affectedRowsFromIndex: 2,
    },
    assignments: { "nearest-supported-bundle-metadata": 1 },
  };
  const changes = [change];
  mutate({ change, report, changes });
  const bytes = gzipSync(changes.map((c) => JSON.stringify(c) + "\n").join(""));
  report.overlaySha256 ??= sha256(bytes);
  await writeFile(join(directory, "report.json"), JSON.stringify(report));
  await writeFile(join(directory, "ownership.jsonl.gz"), bytes);
  try {
    return await packageOwnership({
      directory,
      files: new Map([[file.resourceId, file]]),
      scanReport: {
        source: {
          sourceId: "source",
          scope: {
            kind: "installer-resource-projection",
            extractionReportSha256: "extraction",
          },
        },
      },
      scanHashes: { "report.json": "scan", "files.jsonl.gz": "index" },
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("ownership overlay is pinned to exact scan, index and unchanged before-context", async () => {
  const valid = await fixture();
  assert.equal(valid.changes.size, 1);
  for (
    const mutate of [
      ({ report }) => report.inputHashes.index = "different",
      ({ report }) => report.inputHashes.scanReport = "different",
      ({ report }) => report.sourceId = "different",
      ({ report }) => report.policy.version = 6,
      ({ change }) => change.resourceSha256 = "c".repeat(64),
      ({ change }) => change.before.resourcePath = "changed",
      ({ change }) => change.indexedRows = 3,
    ]
  ) await assert.rejects(fixture(mutate));
});

test("ownership overlay rejects unsafe or unsupported metadata even with regenerated checksums", async () => {
  for (
    const mutate of [
      ({ change }) => change.after.bundlePath = "/Other.pptheme",
      ({ change }) => change.after.bundlePath = "/../Theme.pptheme",
      ({ change }) => change.after.resourcePath = "fabricated",
      ({ change }) =>
        change.after.evidence.metadata[0].imagePath = "/Elsewhere/Info.plist",
      ({ change }) => change.after.evidence.metadata[0].identifier = "",
      ({ change }) => change.after.evidence.metadata = [],
      ({ change }) =>
        change.after.evidence.problems = [{ message: "conflicting" }],
      ({ change }) => change.after.evidence.version = 4,
    ]
  ) await assert.rejects(fixture(mutate));
});

test("ownership overlay rejects duplicates, missing changes and checksum drift", async () => {
  for (
    const mutate of [
      ({ changes }) => changes.push(changes[0]),
      ({ changes }) => changes.pop(),
      ({ report }) => report.overlaySha256 = "c".repeat(64),
      ({ report }) => report.assignments = { unbundled: 1 },
    ]
  ) await assert.rejects(fixture(mutate));
});
