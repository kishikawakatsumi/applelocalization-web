// Streaming consistency check of the diagnostic image output, not a DB import.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: { input: { type: "string" }, output: { type: "string" } },
});
if (!values.input || !values.output) {
  throw new Error("--input and --output are required");
}
const report = JSON.parse(
  await readFile(join(values.input, "report.json"), "utf8"),
);
assert.ok(
  ["scanned-with-issues", "complete-within-scope"].includes(report.status),
  "Scan did not finish",
);
async function* lines(name) {
  const input = createReadStream(join(values.input, name + ".jsonl.gz"));
  const unzip = createGunzip();
  input.on("error", (error) => unzip.destroy(error));
  const stream = input.pipe(unzip);
  // Split only at the JSONL byte delimiter LF. Unicode U+2028/U+2029 inside
  // JSON strings are valid text, not record boundaries (readline splits them).
  stream.setEncoding("utf8");
  let pending = "";
  try {
    for await (const chunk of stream) {
      pending += chunk;
      let start = 0, end;
      while ((end = pending.indexOf("\n", start)) !== -1) {
        const line = pending.slice(start, end);
        if (line) yield JSON.parse(line);
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    if (pending) yield JSON.parse(pending);
  } finally {
    input.destroy();
    stream.destroy();
  }
}
const files = new Map(), rowCounts = new Map();
const counts = {
  files: 0,
  parsedFiles: 0,
  failedFiles: 0,
  rows: 0,
  textRows: 0,
  structuredRows: 0,
  issues: 0,
  symlinks: 0,
  quarantinedFiles: 0,
};
for await (const file of lines("files")) {
  assert.ok(!files.has(file.resourceId), "Duplicate resource ID");
  assert.equal(file.sourceId, report.source.sourceId);
  files.set(file.resourceId, file);
  rowCounts.set(file.resourceId, 0);
  counts.files++;
  if (file.status === "parsed") counts.parsedFiles++;
  else {
    assert.equal(file.status, "failed");
    counts.failedFiles++;
    if (file.quarantinePath) {
      assert.ok(
        /^quarantine\/[a-f0-9]{64}\.(strings|loctable|stringsdict)$/.test(
          file.quarantinePath,
        ),
      );
      const bytes = await readFile(join(values.input, file.quarantinePath));
      assert.equal(bytes.length, file.bytes);
      assert.equal(
        createHash("sha256").update(bytes).digest("hex"),
        file.sha256,
      );
      counts.quarantinedFiles++;
    }
  }
}
const sampleKeys = new Set(["Open", "Cancel", "Delete", "Done"]);
const variants = new Map();
let progressAt = Date.now();
for await (const row of lines("rows")) {
  const file = files.get(row.resourceId);
  assert.ok(file, "Row has no file provenance");
  assert.equal(file.status, "parsed", "Row points to a failed file");
  assert.equal(typeof row.language, "string");
  assert.ok(row.language.length);
  assert.equal(typeof row.key, "string");
  assert.ok(["text", "structured"].includes(row.targetKind));
  if (row.targetKind === "text") assert.equal(typeof row.target, "string");
  else {assert.ok(
      row.target !== null && typeof row.target === "object" &&
        !Array.isArray(row.target),
    );}
  rowCounts.set(row.resourceId, rowCounts.get(row.resourceId) + 1);
  counts.rows++;
  counts[row.targetKind === "text" ? "textRows" : "structuredRows"]++;
  if (
    row.language === "ja" && row.targetKind === "text" &&
    sampleKeys.has(row.key)
  ) {
    if (!variants.has(row.key)) variants.set(row.key, new Map());
    const targets = variants.get(row.key);
    if (!targets.has(row.target)) {
      targets.set(row.target, {
        target: row.target,
        occurrences: 0,
        examples: [],
      });
    }
    const target = targets.get(row.target);
    target.occurrences++;
    if (target.examples.length < 3) {
      target.examples.push({
        bundlePath: file.bundlePath,
        imagePath: file.imagePath,
      });
    }
  }
  if (Date.now() - progressAt > 10000) {
    console.log(JSON.stringify({ checkedRows: counts.rows }));
    progressAt = Date.now();
  }
}
for (const [id, file] of files) {
  assert.equal(
    rowCounts.get(id),
    file.status === "parsed" ? file.rows : 0,
    file.imagePath,
  );
}
for await (const issue of lines("issues")) {
  assert.ok(issue.imagePath);
  counts.issues++;
}
for await (const link of lines("symlinks")) {
  assert.ok(link.imagePath);
  counts.symlinks++;
}
assert.equal(counts.files, report.counts.resourceFiles);
assert.equal(counts.quarantinedFiles, report.counts.quarantinedFiles);
for (
  const key of [
    "parsedFiles",
    "failedFiles",
    "rows",
    "textRows",
    "structuredRows",
    "symlinks",
  ]
) assert.equal(counts[key], report.counts[key], key);
assert.equal(
  counts.issues,
  report.counts.failedFiles + report.counts.enumerationErrors +
    report.counts.crossDeviceDirectories + (report.counts.bundleMetadataIssues ?? 0),
);
const result = {
  status: "output-consistency-verified",
  sourceId: report.source.sourceId,
  counts,
  outsideOldMacOSRoots: [...files.values()].filter((file) =>
    !/^\/(System|Library|Applications)(\/|$)/.test(file.imagePath)
  ),
  illustrativeJapaneseVariants: [...variants].map(([key, targets]) => ({
    key,
    language: "ja",
    targets: [...targets.values()],
  })),
  limitations: [
    "This verifies output integrity, not completeness of the image or correctness of every parsed translation.",
    "Variant examples cover only four exact resource keys in ja; no cross-bundle language correspondence is inferred.",
  ],
};
await writeFile(values.output, JSON.stringify(result, null, 2) + "\n", {
  flag: "wx",
});
console.log(JSON.stringify({ status: result.status, counts }));
