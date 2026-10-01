import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonLineWriter } from "../scripts/localization-jsonl.mjs";
import { fileHash } from "../scripts/collection-checkpoints.mjs";
import { inspectUnlocalizedResources } from "../scripts/inspect-unlocalized-resources.mjs";
import {
  auditFilenameSupplement,
  extractFilenameSupplement,
} from "../scripts/extract-filename-localizations.mjs";
test("inspection streams an index exceeding 64 MiB without retaining irrelevant peer metadata", async () => {
  const temp = await mkdtemp(join(tmpdir(), "inspection-large-index-")),
    root = join(temp, "image"),
    input = join(temp, "scan"),
    output = join(temp, "inspection");
  await mkdir(root);
  await mkdir(input);
  const writer = new JsonLineWriter(join(input, "files.jsonl.gz")),
    padding = "x".repeat(2 * 1024 ** 2);
  for (let id = 0; id < 34; id++) {
    await writer.line(
      JSON.stringify({
        resourceId: String(id),
        sourceId: "fixture",
        imagePath: `/Demo/en.lproj/Item${id}.strings`,
        status: "parsed",
        padding,
      }) + "\n",
    );
  }
  await writer.close();
  await writeFile(
    join(input, "report.json"),
    JSON.stringify({
      status: "complete-within-scope",
      source: { sourceId: "fixture" },
      counts: { resourceFiles: 34 },
    }),
  );
  const report = await inspectUnlocalizedResources({ root, input, output });
  assert.equal(report.status, "inspected-not-imported");
  assert.equal(report.counts.files, 0);
  assert.equal(
    report.indexSha256,
    await fileHash(join(input, "files.jsonl.gz")),
  );
  const supplemental = {
    root,
    scan: input,
    inspection: output,
    output: join(temp, "supplement"),
    requireReadOnlyMount: false,
  };
  await extractFilenameSupplement(supplemental);
  await auditFilenameSupplement({
    ...supplemental,
    input: supplemental.output,
  });
});
