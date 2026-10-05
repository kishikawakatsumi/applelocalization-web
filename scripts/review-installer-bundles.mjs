// A separately versioned ownership correction overlay; never rewrites scan rows.
import assert from "node:assert/strict";
import process from "node:process";
import { lstat, mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { assignBundle, bundlePolicies } from "./bundle-assignment.mjs";
import { readBundleMetadata } from "./bundle-metadata.mjs";
import { safeRead } from "./inspect-unlocalized-resources.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (a, b) => b === a || b.startsWith(a + "/");

export async function reviewInstallerBundles({ run, scan, output }) {
  run = await realpath(run);
  scan = await realpath(scan);
  const root = await realpath(join(run, "selected-tree"));
  assert.notEqual(root, "/");
  output = join(await realpath(dirname(resolve(output))), basename(output));
  assert.ok(
    !inside(run, output) && !inside(scan, output),
    "Output must be outside inputs",
  );
  const extractionBytes = await safeRead(run, "result.json");
  const extraction = JSON.parse(extractionBytes);
  const sourceBytes = await safeRead(scan, "report.json"),
    source = JSON.parse(sourceBytes);
  assert.equal(extraction.status, "resource-projection-bom-matched");
  assert.ok(
    ["complete-within-scope", "scanned-with-issues"].includes(source.status),
  );
  assert.equal(source.source.scope.kind, "installer-resource-projection");
  assert.deepEqual(
    source.bundlePolicy,
    bundlePolicies[4],
    "Historical v4-to-v5 overlay requires an unchanged v4 scan",
  );
  assert.equal(
    source.source.scope.extractionReportSha256,
    hash(extractionBytes),
  );
  assert.equal(
    source.source.scope.archiveSha256,
    extraction.identity.archiveSha256,
  );
  assert.equal(await realpath(source.source.root), root);
  const indexBytes = await safeRead(scan, "files.jsonl.gz");
  const originsBytes = await safeRead(run, "origins.json"),
    origins = JSON.parse(originsBytes);
  const expected = JSON.parse(await safeRead(run, "expected.json"));
  const files = gunzipSync(indexBytes, { maxOutputLength: 64 * 1024 ** 2 })
    .toString("utf8").trim().split("\n").map(JSON.parse);
  assert.equal(files.length, source.counts.resourceFiles);
  const paths = new Set(), ids = new Set();
  const policy = bundlePolicies[5];
  const device = (await lstat(root)).dev;
  const cache = new Map([["", null]]),
    issues = [],
    records = [],
    remaining = [];
  const counts = {
    files: 0,
    changedFiles: 0,
    previouslyUnbundled: 0,
    nestedBoundaryChanges: 0,
    affectedRowsFromIndex: 0,
  };
  const assignments = {}, verifiedMetadata = new Set();
  async function directory(path) {
    if (cache.has(path)) return cache.get(path);
    assert.ok(
      path.startsWith("/") &&
        path.slice(1).split("/").every((p) => p && p !== "." && p !== ".."),
    );
    const inherited = await directory(
      dirname(path) === "/" ? "" : dirname(path),
    );
    const stat = await lstat(root + path);
    assert.ok(
      stat.isDirectory() && !stat.isSymbolicLink() && stat.dev === device,
      "Unsafe ancestor",
    );
    const bundle = await assignBundle({
      path: root + path,
      imagePath: path,
      inherited,
      device,
      policy,
      decode: readBundleMetadata,
      onIssue: (imagePath, e) => issues.push({ imagePath, error: e.message }),
    });
    for (const m of bundle?.evidence.metadata ?? []) {
      assert.equal(
        m.sha256,
        origins[m.imagePath.slice(1)]?.sha256,
        "Metadata differs from extraction origin",
      );
      verifiedMetadata.add(m.imagePath);
    }
    cache.set(path, bundle);
    return bundle;
  }
  for (const file of files) {
    const path = file.imagePath;
    assert.ok(
      typeof path === "string" && path.startsWith("/") && !paths.has(path),
    );
    assert.ok(!ids.has(file.resourceId));
    paths.add(path);
    ids.add(file.resourceId);
    assert.equal(file.sourceId, source.source.sourceId);
    assert.equal(file.resourceId, hash(JSON.stringify([file.sourceId, path])));
    const relative = path.slice(1);
    assert.ok(
      Object.hasOwn(expected, relative),
      "Resource absent from selection",
    );
    const original = await safeRead(root, relative);
    assert.equal(hash(original), file.sha256, "Resource differs from scan");
    assert.equal(
      file.sha256,
      origins[relative]?.sha256,
      "Resource differs from extraction",
    );
    assert.equal(original.length, expected[relative]);
    const bundle = await directory(dirname(path));
    const newPath = bundle?.path ?? null;
    const assignment = bundle?.assignment ?? "unbundled";
    assignments[assignment] = (assignments[assignment] ?? 0) + 1;
    counts.files++;
    if (newPath !== file.bundlePath) {
      assert.equal(
        assignment,
        "nearest-supported-bundle-metadata",
        "Never apply unconfirmed boundaries",
      );
      counts.changedFiles++;
      counts[
        file.bundlePath === null
          ? "previouslyUnbundled"
          : "nestedBoundaryChanges"
      ]++;
      counts.affectedRowsFromIndex += file.rows ?? 0;
      records.push({
        resourceId: file.resourceId,
        sourceId: file.sourceId,
        imagePath: path,
        resourceSha256: file.sha256,
        before: {
          bundlePath: file.bundlePath,
          resourcePath: file.resourcePath,
          assignment: file.bundleAssignment,
        },
        after: {
          bundlePath: newPath,
          resourcePath: path.slice(newPath.length + 1),
          assignment,
          evidence: bundle.evidence,
        },
        indexedRows: file.rows ?? 0,
      });
    }
    if (assignment !== "nearest-supported-bundle-metadata") {
      remaining.push({
        resourceId: file.resourceId,
        imagePath: path,
        bundlePath: newPath,
        assignment,
      });
    }
  }
  const selectedResources = Object.keys(expected).filter((p) =>
    /\.(strings|stringsdict|loctable)$/.test(p)
  ).map((p) => "/" + p).sort();
  assert.deepEqual(
    [...paths].sort(),
    selectedResources,
    "Incomplete resource index coverage",
  );
  assert.equal(
    files.reduce((n, f) => {
      assert.ok(f.status === "parsed" || f.status === "failed");
      const rows = f.status === "parsed" ? f.rows : 0;
      assert.ok(Number.isSafeInteger(rows) && rows >= 0);
      return n + rows;
    }, 0),
    source.counts.rows,
    "Indexed row totals differ from scan",
  );
  const bytes = gzipSync(records.map((r) => JSON.stringify(r) + "\n").join(""));
  const codeHashes = {};
  const scripts = dirname(fileURLToPath(import.meta.url));
  for (
    const name of [
      "review-installer-bundles.mjs",
      "bundle-assignment.mjs",
      "bundle-metadata.mjs",
      "inspect-unlocalized-resources.mjs",
      "extract-mounted-bundle.mjs",
    ]
  ) {
    codeHashes[name] = hash(await safeRead(scripts, name));
  }
  const report = {
    status: "verified-ownership-overlay-not-applied",
    formatVersion: 1,
    sourceId: source.source.sourceId,
    policy,
    counts,
    assignments,
    verifiedMetadataFiles: verifiedMetadata.size,
    inputHashes: {
      scanReport: hash(sourceBytes),
      index: hash(indexBytes),
      extraction: hash(extractionBytes),
      origins: hash(originsBytes),
    },
    codeHashes,
    overlaySha256: hash(bytes),
    issues,
    remaining,
    published: false,
    limitations: [
      "Apply explicitly to matching resource IDs and pinned scan only; never concatenate as new translations.",
      "Every indexed resource and ownership metadata was rehashed; affected row counts come from the previously audited index, not a new row scan.",
      "Languages, keys, values and resource IDs are unchanged. Corrected inner boundaries may change future table grouping.",
      "Defaults and saved v3/v4 policies remain unchanged; no package, database or web changes.",
    ],
  };
  await mkdir(output);
  await writeFile(join(output, "ownership.jsonl.gz"), bytes, { flag: "wx" });
  await writeFile(
    join(output, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" },
  );
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      run: { type: "string" },
      scan: { type: "string" },
      output: { type: "string" },
    },
  });
  assert.ok(
    values.run && values.scan && values.output,
    "--run, --scan and --output required",
  );
  const r = await reviewInstallerBundles(values);
  console.log(
    JSON.stringify({
      status: r.status,
      counts: r.counts,
      assignments: r.assignments,
    }),
  );
}
