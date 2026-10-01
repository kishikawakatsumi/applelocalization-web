// Separate, evidence-bearing supplement; never rewrites the primary scan or imports into DB.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { decodePlist } from "./extract-mounted-bundle.mjs";
import { readJsonLines } from "./localization-jsonl.mjs";
import {
  assessResource,
  bundleMetadata,
  safeRead,
  verifiedFile,
} from "./inspect-unlocalized-resources.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (root, path) => path === root || path.startsWith(root + "/");
const jsonLines = (bytes) =>
  bytes.toString("utf8").split("\n").filter(Boolean).map((line) =>
    JSON.parse(line)
  );
const unzip = (bytes) => gunzipSync(bytes, { maxOutputLength: 64 * 1024 ** 2 });
const encode = (records) =>
  gzipSync(records.map((record) => JSON.stringify(record) + "\n").join(""));
const policy = {
  name: "reviewed-filename-conventions",
  version: 1,
  languageBasis: "filename-convention",
  languageStatus: "inferred",
};

async function buildSupplement(
  { root, scan, inspection, decode = decodePlist, requireReadOnlyMount = true },
) {
  const imageRoot = await realpath(root),
    scanRoot = await realpath(scan),
    inspectionRoot = await realpath(inspection);
  assert.notEqual(imageRoot, "/", "Refusing host root");
  if (requireReadOnlyMount) {
    const line = execFileSync("/sbin/mount", [], { encoding: "utf8" }).split(
      "\n",
    ).find((line) => line.includes(` on ${imageRoot} (`));
    assert.ok(
      line &&
        line.split(" (").at(-1).replace(/\)$/, "").split(", ").includes(
          "read-only",
        ),
      "Input must be the root of a read-only mount",
    );
  }
  const scanReportBytes = await safeRead(scanRoot, "report.json");
  const indexBytes = await safeRead(scanRoot, "files.jsonl.gz");
  const inspectionReportBytes = await safeRead(inspectionRoot, "report.json");
  const inspectionBytes = await safeRead(inspectionRoot, "files.jsonl");
  const scanReport = JSON.parse(scanReportBytes),
    investigation = JSON.parse(inspectionReportBytes);
  assert.ok(
    ["scanned-with-issues", "complete-within-scope"].includes(
      scanReport.status,
    ),
  );
  assert.equal(investigation.status, "inspected-not-imported");
  assert.equal(investigation.counts.errors, 0);
  assert.equal(investigation.sourceId, scanReport.source.sourceId);
  assert.equal(
    investigation.indexSha256,
    hash(indexBytes),
    "Inspection refers to a different scan index",
  );
  const byId = new Map(), seen = new Set(), indexHashes = {};
  for await (
    const file of readJsonLines(scanRoot, "files.jsonl.gz", indexHashes)
  ) {
    assert.ok(!seen.has(file.resourceId), "Duplicate resource ID in scan");
    seen.add(file.resourceId);
    if (
      file.status === "failed" &&
      file.error ===
        "Expected exactly one nonempty .lproj directory; refusing to guess language"
    ) byId.set(file.resourceId, file);
  }
  assert.equal(
    indexHashes["files.jsonl.gz"],
    hash(indexBytes),
    "Scan index changed while streaming",
  );
  assert.equal(
    seen.size,
    scanReport.counts.resourceFiles,
    "Index resource count differs from scan",
  );
  const inspected = jsonLines(inspectionBytes);
  assert.equal(
    new Set(inspected.map((file) => file.resourceId)).size,
    inspected.length,
    "Duplicate resource ID in inspection",
  );
  assert.equal(inspected.length, investigation.counts.files);
  // Verify the entire inspection's coverage; never silently ignore omitted candidates.
  const unresolved = [...byId.values()];
  assert.deepEqual(
    inspected.map((file) => file.resourceId).sort(),
    unresolved.map((file) => file.resourceId).sort(),
  );
  const files = [], rows = [], deferred = [];
  for (const record of inspected) {
    const {
      metadata: savedMetadata,
      assessment,
      inspectionError,
      ...original
    } = record;
    assert.equal(inspectionError, undefined);
    const file = byId.get(record.resourceId);
    assert.deepEqual(original, file, "Inspection provenance differs from scan");
    assert.equal(file.sourceId, investigation.sourceId);
    assert.equal(
      file.resourceId,
      hash(JSON.stringify([file.sourceId, file.imagePath])),
    );
    assert.ok(
      /^quarantine\/[a-f0-9]{64}\.(strings|stringsdict)$/.test(
        file.quarantinePath,
      ),
    );
    const bytes = await verifiedFile(scanRoot, file, file.quarantinePath);
    await verifiedFile(imageRoot, file, file.imagePath.slice(1));
    const metadata = await bundleMetadata(imageRoot, file, decode);
    assert.deepEqual(
      metadata,
      savedMetadata,
      "Bundle metadata changed since inspection",
    );
    const data = decode(bytes);
    const current = assessResource(file, data, metadata);
    const candidate = current.category === "filename-language-candidate";
    assert.equal(
      candidate,
      assessment.category === "filename-language-candidate",
      "Filename candidate classification changed",
    );
    assert.equal(current.entries, assessment.entries);
    if (!candidate) {
      deferred.push({
        resourceId: file.resourceId,
        imagePath: file.imagePath,
        category: assessment.category,
        entries: current.entries,
      });
      continue;
    }
    assert.deepEqual(
      current.filenameEvidence,
      assessment.filenameEvidence,
      "Filename evidence changed",
    );
    assert.equal(current.proposedLanguage, assessment.proposedLanguage);
    assert.ok(file.bundlePath && inside(file.bundlePath, file.imagePath));
    assert.equal(
      file.resourcePath,
      file.imagePath.slice(file.bundlePath.length + 1),
    );
    const evidence = current.filenameEvidence;
    const languageEvidence = {
      ...policy,
      rule: evidence.rule,
      rawToken: evidence.rawToken,
      language: evidence.language,
      resourceSha256: file.sha256,
      metadata,
    };
    const entries = Object.entries(data).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    );
    for (const [key, target] of entries) {
      assert.equal(
        typeof target,
        "string",
        "Filename supplement supports only text .strings",
      );
      rows.push({
        resourceId: file.resourceId,
        language: evidence.language,
        languageRaw: evidence.rawToken,
        languageBasis: policy.languageBasis,
        languageStatus: policy.languageStatus,
        key,
        targetKind: "text",
        target,
      });
    }
    files.push({
      ...file,
      originalScanStatus: file.status,
      status: "parsed-with-filename-language",
      originalScanError: file.error,
      format: "strings",
      rows: entries.length,
      languageEvidence,
    });
  }
  const expected = investigation.categories["filename-language-candidate"] ??
    { files: 0, entries: 0 };
  assert.equal(files.length, expected.files);
  assert.equal(rows.length, expected.entries);
  const rules = {};
  for (const file of files) {
    const name = file.languageEvidence.rule;
    rules[name] ??= { files: 0, rows: 0 };
    rules[name].files++;
    rules[name].rows += file.rows;
  }
  return {
    files,
    rows,
    deferred,
    roots: [imageRoot, scanRoot, inspectionRoot],
    summary: {
      formatVersion: 1,
      outputKind: "filename-language-supplement",
      policy,
      sourceId: investigation.sourceId,
      inputs: {
        scanReportSha256: hash(scanReportBytes),
        indexSha256: hash(indexBytes),
        inspectionReportSha256: hash(inspectionReportBytes),
        inspectionFilesSha256: hash(inspectionBytes),
      },
      counts: {
        inspectedFiles: inspected.length,
        extractedFiles: files.length,
        rows: rows.length,
        textRows: rows.length,
        structuredRows: 0,
        deferredFiles: deferred.length,
      },
      rules,
    },
  };
}

export async function extractFilenameSupplement(options) {
  const expected = await buildSupplement(options);
  const destination = join(
    await realpath(dirname(resolve(options.output))),
    basename(options.output),
  );
  assert.ok(
    expected.roots.every((root) => !inside(root, destination)),
    "Output must be outside inputs",
  );
  // Build and validate before creating output; report is written last as completion marker.
  await mkdir(destination);
  const outputHashes = {};
  for (const name of ["files", "rows", "deferred"]) {
    const bytes = encode(expected[name]);
    await writeFile(join(destination, name + ".jsonl.gz"), bytes, {
      flag: "wx",
    });
    outputHashes[name] = hash(bytes);
  }
  const report = {
    ...expected.summary,
    status: "extracted-not-imported",
    createdAt: new Date().toISOString(),
    outputHashes,
    limitations: [
      "Supplement only: the original scan and all quarantined resources remain unchanged. No DB or Web changes.",
      "All languages here are inferred from scoped filename conventions, not .lproj/loctable declarations or runtime verification.",
      "Original resource IDs, paths, bundle context, raw language tokens, exact values and duplicate occurrences are preserved.",
      "No table pairing or English source-text relationship is inferred. Resource keys are not assumed to be source sentences.",
      "Do not concatenate into the primary scan: these resource IDs refer to previously failed files and require an explicit supplement-aware importer.",
    ],
  };
  await writeFile(
    join(destination, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" },
  );
  return report;
}

export async function auditFilenameSupplement(options) {
  const expected = await buildSupplement(options);
  const input = await realpath(options.input);
  const report = JSON.parse(await safeRead(input, "report.json"));
  assert.equal(report.status, "extracted-not-imported");
  for (const [key, value] of Object.entries(expected.summary)) {
    assert.deepEqual(report[key], value, `Report mismatch: ${key}`);
  }
  for (const name of ["files", "rows", "deferred"]) {
    const bytes = await safeRead(input, name + ".jsonl.gz");
    assert.equal(
      hash(bytes),
      report.outputHashes[name],
      `Output hash mismatch: ${name}`,
    );
    // Re-decode originals and compare EVERY row, not just the output counts/hashes.
    assert.deepEqual(
      jsonLines(unzip(bytes)),
      expected[name],
      `Original-content mismatch: ${name}`,
    );
  }
  return {
    status: "supplement-content-verified",
    sourceId: report.sourceId,
    counts: report.counts,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      root: { type: "string" },
      scan: { type: "string" },
      inspection: { type: "string" },
      output: { type: "string" },
      input: { type: "string" },
    },
  });
  const [command] = positionals;
  assert.ok(
    positionals.length === 1 && ["extract", "audit"].includes(command),
    "Use extract or audit",
  );
  assert.ok(
    values.root && values.scan && values.inspection,
    "--root, --scan and --inspection are required",
  );
  assert.ok(
    command === "extract"
      ? values.output && !values.input
      : values.input && !values.output,
    "extract requires --output; audit requires --input",
  );
  console.log(
    JSON.stringify(
      await (command === "extract"
        ? extractFilenameSupplement(values)
        : auditFilenameSupplement(values)),
      null,
      2,
    ),
  );
}
