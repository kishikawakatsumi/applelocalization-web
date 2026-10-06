// One pinned IPSW component per disposable macOS runner. No release/image push or DB connection.
import assert from "node:assert/strict";
import { releaseDatabase } from "./database-name.mjs";
import { execFile } from "node:child_process";
import { mkdir, readFile, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { fileHash, writeJson } from "./collection-checkpoints.mjs";
import {
  regularFiles,
  validateAcquisition,
} from "./acquire-ipsw-component.mjs";
import { runImageJob } from "./run-image-job.mjs";
import {
  collectOTAComponent,
  validateOTAInput,
} from "./collect-ota-component.mjs";
import { exportTransfer } from "./package-transfer.mjs";
import { exportIntermediateRelease } from "./intermediate-release.mjs";
import { writeIntermediateAssets } from "./intermediate-assets.mjs";
import { verifyIntermediateRelease } from "./intermediate-release.mjs";
import { prepareDurableReleaseSQL } from "./release-durable-sql.mjs";

const planURL = new URL("./collection-batch-20261002.json", import.meta.url);
const json = async (path) => JSON.parse(await readFile(path));
export function validateBatchPlan(plan) {
  assert.equal(plan.formatVersion, 1);
  assert.equal(plan.published, false);
  assert.equal(plan.targets.length, 12);
  assert.equal(new Set(plan.targets.map((x) => x.id)).size, 12);
  assert.ok(plan.jobs.length > 0 && plan.jobs.length <= 36);
  assert.equal(new Set(plan.jobs.map((x) => x.key)).size, plan.jobs.length);
  assert.equal(new Set(plan.jobs.map((x) => x.schema)).size, plan.jobs.length);
  assert.equal(plan.completeOS, false);
  for (const target of plan.targets) {
    assert.match(target.id, /^(ios|macos)[0-9]+$/);
    assert.equal(
      target.id,
      target.platform.toLowerCase() + target.version.split(".")[0],
    );
    assert.ok(
      ["ipsw-input-pinned", "ota-input-pinned", "alternative-route-pending"]
        .includes(
          target.status,
        ),
    );
    assert.equal(
      plan.jobs.some((x) => x.target === target.id),
      target.status !== "alternative-route-pending",
    );
  }
  for (const job of plan.jobs) {
    assert.match(
      job.key,
      /^(ios|macos)[0-9]+-(os|appos|systemos(?:-arm64e|-x86_64)?)$/,
    );
    const target = plan.targets.find((x) => x.id === job.target);
    assert.ok(target);
    assert.ok(
      ["ipsw-input-pinned", "ota-input-pinned"].includes(target.status),
    );
    assert.equal(
      target.status,
      job.input.kind === "ota-full" ? "ota-input-pinned" : "ipsw-input-pinned",
    );
    assert.equal(job.input.version, target.version);
    assert.equal(job.input.build, target.build);
    assert.equal(job.input.os, target.platform);
    assert.equal(job.completeOS, false);
    const suffix = {
      OS: "os",
      "Cryptex1,AppOS": "appos",
      "Cryptex1,SystemOS": "systemos",
      "regular-payload": "os",
      "cryptex-app": "appos",
      "cryptex-system-arm64e": "systemos-arm64e",
      "cryptex-system-x86_64": "systemos-x86_64",
    }[job.input.component];
    assert.ok(suffix);
    assert.equal(job.key, `${target.id}-${suffix}`);
    assert.equal(
      job.schema,
      `localization_${target.id}_${target.build.toLowerCase()}_${
        suffix.replaceAll("-", "_")
      }`,
    );
    if (job.input.kind === "ota-full") validateOTAInput(job.input);
    else {validateAcquisition({
        ...job.input,
        tool: { path: "/ipsw", sha256: plan.tool.binarySha256 },
      });}
    assert.ok(
      job.input.maximumDownloadBytes <=
        (job.input.kind === "ota-full" ? 20 : 12) * 1024 ** 3,
    );
    assert.ok(job.input.maximumImageBytes <= 16 * 1024 ** 3);
    assert.match(job.schema, /^localization_[a-z0-9_]{1,49}$/);
  }
  assert.equal(
    plan.tool.url,
    "https://github.com/blacktop/ipsw/releases/download/v3.1.728/ipsw_3.1.728_macOS_arm64.tar.gz",
  );
  assert.equal(
    plan.tool.archiveSha256,
    "aee66c946eb29f5f52e8fafd971eec3354d410585eb132cc8b677ac22143b287",
  );
  assert.equal(
    plan.tool.binarySha256,
    "1854dcac3b6b8f225660bca3ad0db15a91361cb57eefcb3a853432f29f5fa36f",
  );
  assert.equal(plan.tool.archiveBytes, 26946550);
  return { include: plan.jobs.map((x) => ({ key: x.key })) };
}
export function producer(env = process.env) {
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REPOSITORY, "kishikawakatsumi/applelocalization-web");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.match(env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
    assert.match(env[key] ?? "", /^[1-9][0-9]*$/);
  }
  return {
    collectorRepository: env.GITHUB_REPOSITORY,
    collectorCommit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    runAttempt: env.GITHUB_RUN_ATTEMPT,
  };
}
export function selectBatchJobs(plan, targets = "all-ready") {
  const matrix = validateBatchPlan(plan);
  if (targets === "all-ready") return matrix;
  const selected = targets.split(",");
  assert.equal(new Set(selected).size, selected.length);
  for (const id of selected) {
    assert.ok(
      plan.targets.some((t) =>
        t.id === id && t.status !== "alternative-route-pending"
      ),
      "Target acquisition route is not ready",
    );
  }
  return {
    include: matrix.include.filter((x) =>
      selected.includes(plan.jobs.find((j) => j.key === x.key).target)
    ),
  };
}
export async function runBatchComponent(
  { mode, key, output, allowDownload = false },
) {
  assert.ok(["collect", "sql"].includes(mode));
  if (mode === "collect") {
    assert.equal(allowDownload, true, "Explicit download approval required");
  }
  const origin = producer(), plan = await json(planURL);
  validateBatchPlan(plan);
  const job = plan.jobs.find((x) => x.key === key);
  assert.ok(job, "Unknown pinned component");
  assert.equal(process.platform, "darwin");
  assert.equal(process.arch, "arm64");
  output = resolve(output);
  const run = promisify(execFile);
  if (mode === "collect") await mkdir(output);
  try {
    if (mode === "collect") {
      const free = await statfs(output),
        required = (12.5 * 1024 ** 3) + job.input.maximumDownloadBytes +
          (job.input.kind === "ota-full"
            ? job.input.memberBytes +
              (job.input.encryptedSource?.maximumDecryptedBytes ?? 0)
            : job.input.imagePath.endsWith(".aea")
            ? job.input.maximumImageBytes
            : 0);
      console.log(
        JSON.stringify({
          stage: "capacity",
          availableBytes: free.bavail * free.bsize,
          requiredBytes: required,
        }),
      );
      assert.ok(
        free.bavail * free.bsize >= required,
        "Insufficient initial space; no cleanup or older-version substitution",
      );
      const toolDir = join(output, "tool");
      await mkdir(toolDir);
      const archive = join(toolDir, "ipsw.tar.gz");
      await run("/usr/bin/curl", [
        "--fail",
        "--silent",
        "--show-error",
        "--location",
        "--proto",
        "=https",
        "--proto-redir",
        "=https",
        "--max-time",
        "240",
        "--max-filesize",
        String(plan.tool.archiveBytes),
        "--output",
        archive,
        plan.tool.url,
      ], { timeout: 250000 });
      assert.equal(await fileHash(archive), plan.tool.archiveSha256);
      await run("/usr/bin/tar", ["-xzf", archive, "-C", toolDir, "ipsw"]);
      const tool = join(toolDir, "ipsw");
      assert.equal(await fileHash(tool), plan.tool.binarySha256);
      const spec = join(output, "input.json");
      await writeJson(spec, {
        ...job.input,
        tool: { path: tool, sha256: plan.tool.binarySha256 },
      });
      const jobRoot = join(output, "work");
      const collected = job.input.kind === "ota-full"
        ? await collectOTAComponent({
          spec: job.input,
          output: jobRoot,
          tool,
          toolSha256: plan.tool.binarySha256,
          progress: (event) => console.log(JSON.stringify(event)),
        })
        : await runImageJob({
          kind: "ipsw",
          spec,
          output: jobRoot,
          allowDownload: true,
          progress: (event) => console.log(JSON.stringify(event)),
        });
      assert.equal(collected.status, "image-job-package-verified-not-imported");
      const transfer = join(output, "transfer"),
        exported = await exportTransfer({
          collection: join(jobRoot, "collection"),
          output: transfer,
        });
      const release = join(output, "intermediate");
      const result = await exportIntermediateRelease({
        input: transfer,
        output: release,
        manifestSha256: exported.manifestSha256,
        provenance: {
          ...origin,
          acquisition: job.input,
          tool: plan.tool,
          configSha256: await fileHash(planURL),
          firstCollectionWithoutPriorContentBaseline: true,
          uncollectedManifestComponents: job.uncollectedManifestComponents,
        },
      });
      const assets = await writeIntermediateAssets({
        input: release,
        output: join(output, "assets"),
        manifestSha256: result.manifestSha256,
      });
      const receipt = {
        status: "batch-component-intermediate-verified",
        ...origin,
        key,
        input: job.input,
        counts: result.counts,
        manifestSha256: result.manifestSha256,
        artifactSha256: assets.artifactSha256,
        sourceId: result.sourceId,
        completeOS: false,
        published: false,
        imported: false,
        firstCollectionWithoutPriorContentBaseline: true,
      };
      await writeJson(join(output, "collection.json"), receipt);
      console.log(JSON.stringify(receipt, null, 2));
      return receipt;
    }
    const collection = await json(join(output, "collection.json"));
    assert.equal(collection.key, key);
    assert.deepEqual(collection.input, job.input);
    for (const field of Object.keys(origin)) {
      assert.equal(collection[field], origin[field]);
    }
    const source = await verifyIntermediateRelease({
      input: join(output, "intermediate"),
      manifestSha256: collection.manifestSha256,
    });
    assert.equal(source.sourceId, collection.sourceId);
    const result = await prepareDurableReleaseSQL({
      input: join(output, "intermediate"),
      output: join(output, "sql"),
      manifestSha256: collection.manifestSha256,
      schema: job.schema,
      database: releaseDatabase,
      progress: (event) => console.log(JSON.stringify(event)),
    });
    const receipt = {
      status: "batch-component-sql-verified-not-imported",
      ...origin,
      key,
      input: job.input,
      counts: source.counts,
      sqlSha256: result.sqlSha256,
      sqlReportSha256: result.sqlReportSha256,
      manifestSha256: collection.manifestSha256,
      sourceId: source.sourceId,
      completeOS: false,
      published: false,
      imported: false,
      apiCompatible: false,
      productionReady: false,
    };
    await writeJson(join(output, "sql", "batch-result.json"), receipt);
    console.log(JSON.stringify(receipt, null, 2));
    return receipt;
  } catch (error) {
    const space = await statfs(output).catch(() => null);
    const acquisitionFiles = await regularFiles(
      join(output, "work", "acquisition"),
    ).catch(() => []);
    await writeJson(join(output, `${mode}-failure.json`), {
      status: "failed-not-published",
      key,
      mode,
      error: String(error).slice(0, 5000),
      availableBytes: space ? space.bavail * space.bsize : null,
      acquisitionBytes: acquisitionFiles.reduce((n, f) => n + f.bytes, 0),
      acquisitionFiles: acquisitionFiles.slice(0, 64).map((f) => ({
        path: f.path.slice(output.length + 1),
        bytes: f.bytes,
      })),
      published: false,
    });
    throw error;
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values: v } = parseArgs({
    options: {
      mode: { type: "string" },
      key: { type: "string" },
      output: { type: "string" },
      targets: { type: "string", default: "all-ready" },
      "allow-download": { type: "boolean", default: false },
    },
  });
  if (v.mode === "matrix") {
    console.log(
      JSON.stringify(selectBatchJobs(await json(planURL), v.targets)),
    );
  } else await runBatchComponent({ ...v, allowDownload: v["allow-download"] });
}
