// Assemble and build a local distribution candidate; never push, read .env or copy PGDATA.
import assert from "node:assert/strict";
import { constants } from "node:fs";
import {
  copyFile,
  mkdir,
  readFile,
  realpath,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { execFile, spawn } from "node:child_process";
import { parseArgs, promisify } from "node:util";
import { safeRead } from "./inspect-unlocalized-resources.mjs";
import { fileHash } from "./collection-checkpoints.mjs";
import {
  localDockerOnly,
  validateLoadReport,
} from "./load-occurrence-staging.mjs";

const templates = fileURLToPath(
  new URL("./templates/durable-image/", import.meta.url),
);
const startupFiles = [
  "Dockerfile",
  "localization-entrypoint.sh",
  "localization-healthcheck.sh",
  "10-localization.sh",
];
const exec = promisify(execFile);
export function validateImageBuild({ baseImage, tag }) {
  assert.match(baseImage ?? "", /^groonga\/pgroonga@sha256:[a-f0-9]{64}$/);
  assert.match(
    tag ?? "",
    /^applelocalization-data-candidate:[a-z0-9][a-z0-9_.-]{0,100}$/,
  );
}
export async function prepareDurableImage(
  { input, output, reportSha256, baseImage, tag },
) {
  validateImageBuild({ baseImage, tag });
  input = await realpath(input);
  output = join(await realpath(dirname(resolve(output))), basename(output));
  assert.ok(
    output !== input && !output.startsWith(input + "/"),
    "Build outside SQL artifacts",
  );
  const reportBytes = await safeRead(input, "report.json"),
    report = JSON.parse(reportBytes);
  const verification = JSON.parse(await safeRead(input, "verification.json"));
  validateLoadReport(report, {
    durable: true,
    reportBytes,
    reportSha256,
    verification,
  });
  assert.equal(await fileHash(join(input, "import.sql.gz")), report.sqlSha256);
  const space = await statfs(input);
  assert.ok(
    space.bavail * space.bsize > 3 * 1024 ** 3,
    "Need 3 GiB for SQL build context and image",
  );
  await mkdir(output);
  const context = join(output, "context"), payload = join(context, "payload");
  await mkdir(context);
  await mkdir(payload);
  for (const file of startupFiles) {
    await copyFile(
      join(templates, file),
      join(context, file),
      constants.COPYFILE_EXCL,
    );
  }
  for (const file of ["import.sql.gz", "report.json", "verification.json"]) {
    await copyFile(
      join(input, file),
      join(payload, file),
      constants.COPYFILE_EXCL,
    );
  }
  assert.equal(
    await fileHash(join(payload, "import.sql.gz")),
    report.sqlSha256,
  );
  assert.equal(await fileHash(join(payload, "report.json")), reportSha256);
  const identity = {
    formatVersion: 1,
    database: report.database,
    schema: report.schema,
    packageManifest: report.packageManifest,
    sqlSha256: report.sqlSha256,
  };
  await writeFile(join(payload, "identity"), JSON.stringify(identity) + "\n", {
    flag: "wx",
  });
  assert.match(report.packageManifest, /^[a-f0-9]{64}$/);
  await writeFile(
    join(payload, "dataset.env"),
    `DATASET_DATABASE=${report.database}\nDATASET_SCHEMA=${report.schema}\nDATASET_MANIFEST=${report.packageManifest}\n`,
    { flag: "wx" },
  );
  const files = [
    "import.sql.gz",
    "report.json",
    "verification.json",
    "identity",
    "dataset.env",
  ];
  const hashes = {};
  for (const file of files) hashes[file] = await fileHash(join(payload, file));
  await writeFile(
    join(payload, "SHA256SUMS"),
    files.map((file) => `${hashes[file]}  ${file}`).join("\n") + "\n",
    { flag: "wx" },
  );
  for (const file of startupFiles) {
    hashes[file] = await fileHash(join(context, file));
  }
  const plan = {
    status: "durable-image-context-prepared",
    ...identity,
    baseImage,
    platform: "linux/amd64",
    tag,
    hashes,
    reportSha256,
    initialization: "verified-compressed-sql-on-first-start",
    productionReady: false,
    published: false,
  };
  await writeFile(
    join(output, "plan.json"),
    JSON.stringify(plan, null, 2) + "\n",
    { flag: "wx" },
  );
  return { output, context, plan };
}
export async function buildDurableImage(options) {
  assert.equal(
    options.allowLocalImageBuild,
    true,
    "Explicit local build approval required",
  );
  localDockerOnly();
  validateImageBuild(options);
  const docker = async (...args) =>
    (await exec("docker", args, { encoding: "utf8", maxBuffer: 1024 * 1024 }))
      .stdout.trim();
  const tags =
    (await docker("image", "ls", "--format", "{{.Repository}}:{{.Tag}}")).split(
      "\n",
    );
  assert.ok(!tags.includes(options.tag), "Never overwrite an existing tag");
  // Cached digest must exist before constructing a context. Build does not use a mutable base tag.
  await docker("image", "inspect", options.baseImage);
  const { output, context, plan } = await prepareDurableImage(options);
  const args = [
    "build",
    "--pull=false",
    "--network=none",
    "--platform=linux/amd64",
    "--provenance=false",
    "--load",
    "--progress=plain",
    "--build-arg",
    `BASE_IMAGE=${plan.baseImage}`,
    "--tag",
    plan.tag,
    "--label",
    `org.applelocalization.package=${plan.packageManifest}`,
    "--label",
    `org.applelocalization.sql=${plan.sqlSha256}`,
    "--iidfile",
    join(output, "image-id"),
    context,
  ];
  const child = spawn("docker", args, { stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  const capture = (bytes) => {
    process.stdout.write(bytes);
    log = (log + bytes).slice(-128000);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const code = await new Promise((res, rej) => {
    child.on("error", rej);
    child.on("close", res);
  });
  await writeFile(join(output, "build.log"), log, { flag: "wx" });
  assert.equal(code, 0, "Docker build failed; context and logs retained");
  const image = (await readFile(join(output, "image-id"), "utf8")).trim();
  assert.match(image, /^sha256:[a-f0-9]{64}$/);
  const result = {
    ...plan,
    status: "durable-image-built-not-startup-verified",
    image,
  };
  await writeFile(
    join(output, "result.json"),
    JSON.stringify(result, null, 2) + "\n",
    { flag: "wx" },
  );
  return result;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values: v } = parseArgs({
    options: {
      ...Object.fromEntries(
        ["input", "output", "report-sha256", "base-image", "tag"].map(
          (k) => [k, { type: "string" }],
        ),
      ),
      "allow-local-image-build": { type: "boolean", default: false },
    },
  });
  console.log(
    JSON.stringify(
      await buildDurableImage({
        ...v,
        reportSha256: v["report-sha256"],
        baseImage: v["base-image"],
        allowLocalImageBuild: v["allow-local-image-build"],
      }),
      null,
      2,
    ),
  );
}
