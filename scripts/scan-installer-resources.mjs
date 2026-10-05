// Verified installer projection -> diagnostic rows. No DB or publication writes.
import assert from "node:assert/strict";
import process from "node:process";
import { execFile } from "node:child_process";
import { mkdir, readFile, realpath } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { extractMountedImage } from "./extract-mounted-image.mjs";
import { fileHash, writeJson } from "./collection-checkpoints.mjs";

const execute = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));
const { values } = parseArgs({
  options: {
    run: { type: "string" },
    output: { type: "string" },
    "bundle-policy-version": { type: "string" },
  },
});
assert.ok(values.run && values.output, "--run and --output are required");
const input = await realpath(values.run), output = resolve(values.output);
const destination = join(
  await realpath(dirname(output)),
  output.split("/").at(-1),
);
assert.ok(
  destination !== input && !destination.startsWith(input + "/"),
  "Output must be outside extraction run",
);
await mkdir(output);
const command = async (executable, args) =>
  (await execute(executable, args, {
    timeout: 2 * 60 * 60 * 1000,
    maxBuffer: 8 * 1024 ** 2,
  })).stdout;
try {
  const extraction = JSON.parse(
    await readFile(join(input, "result.json"), "utf8"),
  );
  assert.equal(extraction.status, "resource-projection-bom-matched");
  assert.equal(await realpath(extraction.tree), join(input, "selected-tree"));
  console.log("Verifying saved payloads and projection before parsing");
  await command("/usr/bin/python3", [
    "-B",
    join(scripts, "audit-installer-resources.py"),
    "--run",
    input,
    "--output",
    join(output, "input-audit.json"),
  ]);
  const audit = JSON.parse(
    await readFile(join(output, "input-audit.json"), "utf8"),
  );
  assert.equal(
    audit.status,
    "saved-payloads-and-projection-independently-verified",
  );
  const code = {};
  for (
    const name of [
      "scan-installer-resources.mjs",
      "extract-mounted-image.mjs",
      "extract-mounted-bundle.mjs",
      "bundle-assignment.mjs",
      "bundle-metadata.mjs",
      "collection-checkpoints.mjs",
      "audit-image-extraction.mjs",
      "audit-installer-resources.py",
      "audit-installer-scan.py",
    ]
  ) {
    code[name] = await fileHash(join(scripts, name));
  }
  await writeJson(join(output, "code.json"), code);
  const identity = {
    version: extraction.identity.version,
    build: extraction.identity.build,
    archiveSha256: extraction.identity.archiveSha256,
    extractionReportSha256: await fileHash(join(input, "result.json")),
    auditSha256: await fileHash(join(output, "input-audit.json")),
  };
  const scan = await extractMountedImage({
    root: extraction.tree,
    output: join(output, "scan"),
    label:
      `macOS-${identity.version}-${identity.build}-installer-regular-payload-${identity.archiveSha256}`,
    requireReadOnlyMount: false,
    installerProjection: identity,
    bundlePolicyVersion: values["bundle-policy-version"] === undefined
      ? undefined
      : Number(values["bundle-policy-version"]),
    progress: (counts) =>
      console.log(JSON.stringify({ stage: "scan", ...counts })),
  });
  const expected = [".strings", ".stringsdict", ".loctable"].reduce(
    (n, ext) => n + (audit.extensions[ext] ?? 0),
    0,
  );
  assert.equal(
    scan.counts.resourceFiles,
    expected,
    "Supported resource coverage differs from verified input",
  );
  console.log("Checking streaming output consistency");
  await command(process.execPath, [
    join(scripts, "audit-image-extraction.mjs"),
    "--input",
    join(output, "scan"),
    "--output",
    join(output, "output-audit.json"),
  ]);
  console.log(
    "Comparing every parsed row with originals and auditing language/bundle evidence",
  );
  await command("/usr/bin/python3", [
    "-B",
    join(scripts, "audit-installer-scan.py"),
    "--run",
    input,
    "--scan",
    join(output, "scan"),
    "--output",
    join(output, "originals-audit.json"),
  ]);
  const originals = JSON.parse(
    await readFile(join(output, "originals-audit.json"), "utf8"),
  );
  await writeJson(join(output, "result.json"), {
    status: "installer-projection-parsed-and-audited",
    scanStatus: scan.status,
    counts: scan.counts,
    source: scan.source,
    languageCodes: scan.languageCodes,
    originalsStatus: originals.status,
    unresolvedFiles: scan.counts.failedFiles,
    published: false,
    limitations: scan.limitations,
  });
  console.log(
    JSON.stringify({
      stage: "complete",
      status: scan.status,
      counts: scan.counts,
      originalsStatus: originals.status,
    }),
  );
} catch (error) {
  await writeJson(join(output, "failed.json"), {
    error: String(error.stack ?? error),
    stderr: error.stderr ?? null,
  });
  process.exitCode = 1;
}
