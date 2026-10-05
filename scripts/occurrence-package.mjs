// Version-aware ownership view. Never mutates or replaces the saved original.
import assert from "node:assert/strict";
import { basename } from "node:path";
import { validateOwnershipChange } from "./package-ownership.mjs";

// Existing candidate entry points stay v1-only; v6 requires explicit opt-in.
export function validateCandidatePackage(report, derivation) {
  if (
    derivation?.policy?.version === 6 && derivation.packageFormatVersion === 2
  ) {
    validateOccurrencePackage(report);
    assert.equal(
      report.formatVersion,
      2,
      "Ownership-v5 candidates require package v2",
    );
  } else {
    assert.equal(
      report.formatVersion,
      1,
      "This candidate policy does not yet support package v2",
    );
  }
}

export function validateOccurrencePackage(report) {
  assert.equal(report.status, "prepared-not-imported");
  assert.equal(report.outputKind, "localization-occurrence-package");
  assert.ok(
    [1, 2].includes(report.formatVersion),
    "Unsupported occurrence package version",
  );
  if (report.formatVersion === 2) {
    for (const key of ["report.json", "ownership.jsonl.gz"]) {
      assert.match(
        report.inputs?.ownership?.[key] ?? "",
        /^[a-f0-9]{64}$/,
        "Missing ownership input hash",
      );
    }
    assert.ok(
      Number.isSafeInteger(report.counts?.ownershipAdjustedResources) &&
        report.counts.ownershipAdjustedResources >= 0,
    );
  }
}

export function effectiveResource(record, report) {
  const original = record.original;
  assert.ok(original && typeof original === "object");
  if (report.formatVersion === 1) {
    assert.ok(
      !Object.hasOwn(record, "effective") &&
        !Object.hasOwn(record, "ownershipCorrection"),
      "v2 ownership fields in v1 package",
    );
    return original;
  }
  assert.equal(
    report.formatVersion,
    2,
    "Unsupported occurrence package version",
  );
  assert.ok(
    Object.hasOwn(record, "effective") &&
      Object.hasOwn(record, "ownershipCorrection"),
    "Missing v2 ownership fields",
  );
  assert.equal(original.resourceId, record.resourceId);
  assert.equal(original.sourceId, record.sourceId);
  assert.equal(record.sourceId, report.sourceId);
  const correction = record.ownershipCorrection;
  let expected = original;
  if (correction !== null) {
    validateOwnershipChange(original, correction);
    expected = {
      ...original,
      bundlePath: correction.after.bundlePath,
      bundleName: basename(correction.after.bundlePath),
      resourcePath: correction.after.resourcePath,
      bundleAssignment: correction.after.assignment,
      bundleEvidence: correction.after.evidence,
    };
    if (original.status === "parsed") {
      expected.tablePath = original.rows > 0 && original.format !== "loctable"
        ? expected.resourcePath.split("/").filter((p) => !p.endsWith(".lproj"))
          .join("/")
        : expected.resourcePath;
    }
  }
  assert.deepEqual(
    record.effective,
    expected,
    "Effective resource differs from recorded correction",
  );
  return record.effective;
}

export function verifyOwnershipCount(report, corrected) {
  if (report.formatVersion === 2) {
    assert.equal(
      corrected,
      report.counts.ownershipAdjustedResources,
      "Ownership correction count differs",
    );
  }
}
