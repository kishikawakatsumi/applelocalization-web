// Read-only comparison of a subtree or whole-image re-extraction with its original scan.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { safeRead } from "../extraction/inspect-unlocalized-resources.mjs";
import { readJsonLines, sha256 } from "../shared/localization-jsonl.mjs";
import { bundlePolicies } from "./bundle-assignment.mjs";

export async function verifyReassignment(
  { baseline, candidate, root, progress = () => {} },
) {
  const oldBytes = await safeRead(baseline, "report.json"),
    newBytes = await safeRead(candidate, "report.json");
  const before = JSON.parse(oldBytes), after = JSON.parse(newBytes);
  for (const report of [before, after]) {
    assert.ok(
      ["complete-within-scope", "scanned-with-issues"].includes(report.status),
    );
  }
  assert.equal(before.source.sourceId, after.source.sourceId);
  assert.ok(
    ["subtree", "whole-image"].includes(after.source.scope?.kind),
    "Missing or invalid candidate scope",
  );
  assert.ok(
    [2, 3, 4, 5, 6].includes(after.bundlePolicy?.version),
    "Unsupported bundle policy",
  );
  if (after.bundlePolicy.version >= 5) {
    assert.deepEqual(
      after.bundlePolicy,
      bundlePolicies[after.bundlePolicy.version],
    );
  }
  const whole = after.source.scope.kind === "whole-image";
  if (whole) {
    assert.ok(
      before.source.scope === undefined ||
        before.source.scope.kind === "whole-image",
      "Whole-image comparison requires a whole-image baseline",
    );
  }
  const scope = whole ? "" : after.source.scope.imagePath;
  assert.ok(
    whole || (scope.startsWith("/") &&
      scope.split("/").slice(1).every((p) => p && p !== "." && p !== "..")),
  );
  root = await realpath(root);
  assert.notEqual(root, "/");
  assert.equal(root, after.source.root);
  const hashes = { baseline: {}, candidate: {} },
    files = { baseline: new Map(), candidate: new Map() },
    evidence = new Map();
  for (
    const [side, directory] of [["baseline", baseline], [
      "candidate",
      candidate,
    ]]
  ) {
    let count = 0;
    for await (
      const f of readJsonLines(directory, "files.jsonl.gz", hashes[side])
    ) {
      count++;
      if (side === "baseline" && !f.imagePath.startsWith(scope + "/")) continue;
      assert.ok(
        f.imagePath.startsWith(scope + "/"),
        "Candidate escaped subtree",
      );
      assert.equal(f.sourceId, after.source.sourceId);
      assert.equal(
        f.resourceId,
        sha256(JSON.stringify([f.sourceId, f.imagePath])),
      );
      assert.ok(!files[side].has(f.resourceId));
      files[side].set(f.resourceId, {
        file: f,
        rows: 0,
        digest: createHash("sha256"),
      });
      if (side === "candidate") {
        for (const m of f.bundleEvidence?.metadata ?? []) {
          const prior = evidence.get(m.imagePath);
          if (prior) {
            assert.deepEqual(prior, m);
          }
          evidence.set(m.imagePath, m);
        }
      }
    }
    assert.equal(
      count,
      (side === "baseline" ? before : after).counts.resourceFiles,
    );
    let rows = 0, last = Date.now();
    for await (
      const row of readJsonLines(directory, "rows.jsonl.gz", hashes[side])
    ) {
      rows++;
      const f = files[side].get(row.resourceId);
      if (f) {
        f.rows++;
        f.digest.update(JSON.stringify(row) + "\n");
      } else assert.equal(side, "baseline", "Candidate row has no provenance");
      if (Date.now() - last > 10000) {
        progress({ side, rows });
        last = Date.now();
      }
    }
    assert.equal(rows, (side === "baseline" ? before : after).counts.rows);
    for (const f of files[side].values()) {
      assert.equal(f.rows, f.file.status === "parsed" ? f.file.rows : 0);
      f.hash = f.digest.digest("hex");
      delete f.digest;
    }
  }
  assert.deepEqual(
    [...files.baseline.keys()].sort(),
    [...files.candidate.keys()].sort(),
    "Changed resource coverage",
  );
  const changes = [], operationalDifferences = [];
  let rows = 0, failed = 0;
  for (const [id, newer] of files.candidate) {
    const older = files.baseline.get(id);
    assert.equal(
      newer.hash,
      older.hash,
      "Changed row values, multiplicity or order: " + id,
    );
    assert.equal(newer.rows, older.rows);
    rows += newer.rows;
    const stable = (f) =>
      Object.fromEntries(
        Object.entries(f).filter(([key]) =>
          ![
            "bundlePath",
            "bundleName",
            "resourcePath",
            "tablePath",
            "bundleAssignment",
            "bundleEvidence",
            "decodeAttempts",
            "retryReason",
          ].includes(key)
        ),
      );
    assert.deepEqual(
      stable(newer.file),
      stable(older.file),
      "Non-bundle provenance changed",
    );
    if (
      newer.file.decodeAttempts !== older.file.decodeAttempts ||
      newer.file.retryReason !== older.file.retryReason
    ) {
      operationalDifferences.push({
        imagePath: newer.file.imagePath,
        before: {
          attempts: older.file.decodeAttempts,
          reason: older.file.retryReason ?? null,
        },
        after: {
          attempts: newer.file.decodeAttempts,
          reason: newer.file.retryReason ?? null,
        },
      });
    }
    assert.equal(
      newer.file.resourcePath,
      newer.file.bundlePath
        ? newer.file.imagePath.slice(newer.file.bundlePath.length + 1)
        : newer.file.imagePath.slice(1),
    );
    if (newer.file.status === "failed") failed++;
    if (newer.file.bundlePath !== older.file.bundlePath) {
      changes.push({
        resourceId: id,
        imagePath: newer.file.imagePath,
        rows: newer.rows,
        oldBundlePath: older.file.bundlePath,
        newBundlePath: newer.file.bundlePath,
        evidence: newer.file.bundleEvidence,
      });
    }
  }
  for (const m of evidence.values()) {
    assert.ok(m.imagePath.startsWith("/"));
    const bytes = await safeRead(root, m.imagePath.slice(1));
    assert.equal(sha256(bytes), m.sha256);
    assert.equal(bytes.length, m.bytes);
  }
  return {
    status: "bundle-reassignment-verified",
    sourceId: after.source.sourceId,
    scope: whole ? "/" : scope,
    scopeKind: whole ? "whole-image" : "subtree",
    baselineReportSha256: sha256(oldBytes),
    candidateReportSha256: sha256(newBytes),
    streamHashes: hashes,
    counts: {
      resources: files.candidate.size,
      rows,
      unchangedFailedResources: failed,
      changedBundleResources: changes.length,
      changedBundleRows: changes.reduce((n, c) => n + c.rows, 0),
      verifiedMetadataFiles: evidence.size,
    },
    changes,
    operationalDifferences,
    limitations: [
      "No DB or package update. Equality covers the explicitly reported scan scope only, not other images or unparsed resources.",
      "Row checks include language, key, value kind, exact value, order, multiplicity and resource ID.",
      "Metadata hashes checked against the current read-only image; not code-signature verification.",
    ],
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: Object.fromEntries(
        ["baseline", "candidate", "root", "output"].map(
          (k) => [k, { type: "string" }],
        ),
      ),
    });
    for (const key of ["baseline", "candidate", "root", "output"]) {
      assert.ok(values[key], `--${key} required`);
    }
    const report = await verifyReassignment({
      ...values,
      progress: (r) => console.log(JSON.stringify(r)),
    });
    await writeFile(values.output, JSON.stringify(report, null, 2) + "\n", {
      flag: "wx",
    });
    console.log(
      JSON.stringify({ status: report.status, counts: report.counts }),
    );
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  }
}
