// Verify an explicitly selected ownership overlay against the exact primary scan.
import assert from "node:assert/strict";
import { extname } from "node:path";
import { bundlePolicies } from "./bundle-assignment.mjs";
import { safeRead } from "./inspect-unlocalized-resources.mjs";
import { readJsonLines, sha256 } from "./localization-jsonl.mjs";

const pathValid = (p) =>
  typeof p === "string" && p.startsWith("/") && !p.includes("\0") &&
  p.slice(1).split("/").every((x) => x && x !== "." && x !== "..");
const inside = (a, b) => b.startsWith(a + "/");

// Also used by downstream readers: a v2 resource must not change source facts.
export function validateOwnershipChange(original, change) {
  assert.equal(change.resourceId, original.resourceId);
  assert.equal(change.sourceId, original.sourceId);
  assert.equal(change.imagePath, original.imagePath);
  assert.equal(change.resourceSha256, original.sha256);
  assert.deepEqual(change.before, {
    bundlePath: original.bundlePath,
    resourcePath: original.resourcePath,
    assignment: original.bundleAssignment,
  });
  assert.equal(
    change.indexedRows,
    original.status === "parsed" ? original.rows : 0,
  );
  const after = change.after, evidence = after.evidence;
  assert.ok(
    pathValid(after.bundlePath) && inside(after.bundlePath, original.imagePath),
  );
  assert.notEqual(
    after.bundlePath,
    original.bundlePath,
    "Ownership overlay must change a boundary",
  );
  if (original.bundlePath !== null) {
    assert.ok(
      inside(original.bundlePath, after.bundlePath),
      "Only a verified inner boundary may replace an existing owner",
    );
  }
  assert.equal(
    after.resourcePath,
    original.imagePath.slice(after.bundlePath.length + 1),
  );
  assert.equal(after.assignment, "nearest-supported-bundle-metadata");
  assert.equal(evidence.version, 5);
  assert.equal(evidence.bundlePath, after.bundlePath);
  assert.equal(evidence.extension, extname(after.bundlePath));
  assert.ok(
    bundlePolicies[5].metadataRequiredExtensions.includes(evidence.extension),
  );
  assert.ok(
    !bundlePolicies[4].metadataRequiredExtensions.includes(evidence.extension),
  );
  assert.equal(evidence.method, "allowlisted-extension-and-info-plist");
  assert.deepEqual(evidence.problems, []);
  assert.ok(Array.isArray(evidence.metadata) && evidence.metadata.length);
  const seen = new Set();
  for (const m of evidence.metadata) {
    assert.ok(pathValid(m.imagePath) && inside(after.bundlePath, m.imagePath));
    assert.ok(
      bundlePolicies[5].metadataLocations.includes(
        m.imagePath.slice(after.bundlePath.length + 1),
      ),
      "Unexpected ownership metadata location",
    );
    assert.ok(!seen.has(m.imagePath));
    seen.add(m.imagePath);
    assert.match(m.sha256, /^[a-f0-9]{64}$/);
    assert.ok(
      Number.isSafeInteger(m.bytes) && m.bytes > 0 &&
        m.bytes <= bundlePolicies[5].maximumMetadataBytes,
    );
    assert.equal(typeof m.identifier, "string");
    assert.match(m.identifier, /^[A-Za-z0-9_.-]+$/);
  }
  assert.equal(new Set(evidence.metadata.map((m) => m.identifier)).size, 1);
}

export async function packageOwnership(
  { directory, files, scanReport, scanHashes },
) {
  const reportBytes = await safeRead(directory, "report.json");
  const report = JSON.parse(reportBytes),
    hashes = { "report.json": sha256(reportBytes) };
  assert.equal(report.status, "verified-ownership-overlay-not-applied");
  assert.equal(report.formatVersion, 1);
  assert.ok(["installer-resource-projection", "whole-image"].includes(scanReport.source.scope?.kind));
  if (scanReport.source.scope.kind === "whole-image") assert.deepEqual(report.scope, scanReport.source.scope, "Ownership scope mismatch");
  assert.equal(report.sourceId, scanReport.source.sourceId);
  assert.deepEqual(
    report.policy,
    bundlePolicies[5],
    "Unknown ownership policy",
  );
  assert.equal(
    report.inputHashes.scanReport,
    scanHashes["report.json"],
    "Ownership scan mismatch",
  );
  assert.equal(
    report.inputHashes.index,
    scanHashes["files.jsonl.gz"],
    "Ownership index mismatch",
  );
  if (scanReport.source.scope.kind === "installer-resource-projection") {
    assert.equal(report.inputHashes.extraction, scanReport.source.scope.extractionReportSha256);
  }
  assert.equal(report.counts.files, files.size);
  const changes = new Map();
  let previouslyUnbundled = 0, nestedBoundaryChanges = 0, affectedRows = 0;
  for await (
    const change of readJsonLines(directory, "ownership.jsonl.gz", hashes)
  ) {
    const original = files.get(change.resourceId);
    assert.ok(
      original && !changes.has(change.resourceId),
      "Unknown or duplicate ownership resource",
    );
    assert.equal(change.sourceId, report.sourceId);
    validateOwnershipChange(original, change);
    changes.set(change.resourceId, change);
    if (original.bundlePath === null) previouslyUnbundled++;
    else nestedBoundaryChanges++;
    affectedRows += change.indexedRows;
  }
  assert.equal(
    hashes["ownership.jsonl.gz"],
    report.overlaySha256,
    "Ownership hash mismatch",
  );
  assert.equal(changes.size, report.counts.changedFiles);
  assert.equal(previouslyUnbundled, report.counts.previouslyUnbundled);
  assert.equal(nestedBoundaryChanges, report.counts.nestedBoundaryChanges);
  assert.equal(affectedRows, report.counts.affectedRowsFromIndex);
  const assignments = {};
  for (const file of files.values()) {
    const assignment = changes.get(file.resourceId)?.after.assignment ??
      file.bundleAssignment;
    assignments[assignment] = (assignments[assignment] ?? 0) + 1;
  }
  assert.deepEqual(assignments, report.assignments);
  return { report, hashes, changes };
}
