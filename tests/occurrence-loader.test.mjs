import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { validateLoadReport } from "../scripts/load-occurrence-staging.mjs";

test("durable loader requires explicit mode, pinned report and matching offline receipt", () => {
  const report = {
    status: "durable-occurrence-sql-prepared",
    database: "localization_staging",
    schema: "localization_fixture_001",
    storage: "logged",
    sqlSha256: "a".repeat(64),
    packageManifest: "b".repeat(64),
  };
  const reportBytes = Buffer.from(JSON.stringify(report));
  const reportSha256 = createHash("sha256").update(reportBytes).digest("hex");
  const verification = {
    ...report,
    status: "durable-release-sql-verified-not-imported",
    sqlReportSha256: reportSha256,
  };
  const options = { durable: true, reportBytes, reportSha256, verification };
  assert.doesNotThrow(() => validateLoadReport(report, options));
  assert.throws(() => validateLoadReport(report));
  assert.throws(() =>
    validateLoadReport(report, { ...options, reportSha256: undefined })
  );
  assert.throws(() =>
    validateLoadReport(report, { ...options, reportBytes: Buffer.from("{}") })
  );
  assert.throws(() =>
    validateLoadReport(report, {
      ...options,
      verification: { ...verification, sqlSha256: "c".repeat(64) },
    })
  );
  assert.throws(() =>
    validateLoadReport({ ...report, database: "production" }, options)
  );
});

test("legacy local loader keeps its original schema and container restrictions", () => {
  const report = {
    status: "staging-sql-prepared",
    database: "localization_staging",
    container: "applelocalization-staging-ios26-20260928",
    schema: "ipsw_trial_fixture",
  };
  assert.doesNotThrow(() => validateLoadReport(report));
  assert.throws(() => validateLoadReport({ ...report, schema: "public" }));
  assert.throws(() => validateLoadReport({ ...report, container: "other" }));
});
