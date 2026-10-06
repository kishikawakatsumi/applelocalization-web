// CI-only aggregation of previously audited SQL. No original resource download or production deployment.
import assert from "node:assert/strict";
import { validateReleaseDatabase } from "./database-name.mjs";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { batch, pipelineProducer, repository } from "./candidate-pipeline.mjs";
import {
  baseImage,
  imageRepository,
  verifyCandidateSearch,
} from "./candidate-bundle-image.mjs";
import {
  composeReleaseContext,
  releaseCatalog,
  releaseTargets,
} from "./compose-release-set.mjs";
import { fileHash, sha256, writeJson } from "./collection-checkpoints.mjs";
import { localDockerOnly } from "./load-occurrence-staging.mjs";
import { psqlLines } from "./occurrence-staging.mjs";

export const inputPins = JSON.parse(
  await readFile(
    new URL("./release-set-inputs-20261002.json", import.meta.url),
  ),
);
const execute = promisify(execFile);
const json = async (path) => JSON.parse(await readFile(path));
const run = async (program, args) =>
  (await execute(program, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 ** 2,
    timeout: 180000,
  })).stdout.trim();
const docker = (...args) => run("docker", args);
// Docker emits PostgreSQL errors on stderr, not stdout. Retain bounded technical
// summaries from BOTH streams, never COPY rows, statements, details or context.
export function summarizeRestoreLogs(stdout, stderr) {
  const components = [], errors = [];
  for (const line of `${stdout}\n${stderr}`.split("\n")) {
    const component = line.match(
      /^Localization component: ([a-z0-9-]+) (start|completed)$/,
    );
    if (component && batch.jobs.some((c) => c.key === component[1])) {
      components.push({ key: component[1], status: component[2] });
    } else if (
      !/\b(?:STATEMENT|DETAIL|CONTEXT):/.test(line) &&
      (/^(?:psql:(?:<stdin>:)?[0-9]+:|[0-9]{4}-[0-9T:. +A-Z-]+\[[0-9]+\])\s*(?:ERROR|FATAL|PANIC):/
        .test(line) ||
        /\bLOG:\s+(?:server process .* (?:terminated|killed)|terminating any other active server processes|all server processes terminated)/
          .test(line))
    ) {
      errors.push(
        line.replace(/'[^']*'|"[^"]*"/g, "<quoted value>").slice(0, 1024),
      );
    }
  }
  return { components: components.slice(-72), errors: errors.slice(-30) };
}
async function restoreLogs(name) {
  let result;
  try {
    result = await execute("docker", ["logs", "--tail", "200", name], {
      encoding: "utf8",
      timeout: 30000,
      maxBuffer: 1024 ** 2,
    });
  } catch (error) {
    result = {
      stdout: error.stdout ?? "",
      stderr: error.stderr ?? "",
      captureIncomplete: true,
    };
  }
  return {
    ...summarizeRestoreLogs(result.stdout, result.stderr),
    captureIncomplete: result.captureIncomplete === true,
  };
}
async function stream(program, args) {
  const child = spawn(program, args, { stdio: "inherit" });
  const code = await new Promise((ok, fail) => {
    child.on("error", fail);
    child.on("close", ok);
  });
  assert.equal(code, 0, `${program} failed`);
}
const api = async (path) =>
  JSON.parse(await run("gh", ["api", `repos/${repository}/${path}`]));

export function validatePins(pins) {
  assert.deepEqual(pins.map((p) => p.target), releaseTargets());
  assert.equal(new Set(pins.map((p) => p.artifact.id)).size, pins.length);
  for (const p of pins) {
    for (
      const n of [p.runId, p.attempt, p.artifact.id, p.artifact.size_in_bytes]
    ) assert.ok(Number.isSafeInteger(n) && n > 0);
    assert.match(p.commit, /^[a-f0-9]{40}$/);
    assert.match(p.artifact.digest, /^sha256:[a-f0-9]{64}$/);
    assert.equal(
      p.artifact.name,
      `candidate-sql-${p.target}-${p.runId}-${p.attempt}`,
    );
    assert.ok(p.artifact.size_in_bytes < 4 * 1024 ** 3);
  }
  return pins;
}
export function validateSource(pin, source, jobs, artifact) {
  assert.equal(source.id, pin.runId);
  assert.equal(source.run_attempt, pin.attempt);
  assert.equal(source.head_sha, pin.commit);
  assert.equal(source.repository?.full_name, repository);
  assert.equal(source.head_repository?.full_name, repository);
  assert.ok(Number.isSafeInteger(source.repository?.id));
  assert.equal(source.head_repository?.id, source.repository.id);
  assert.equal(
    source.path,
    ".github/workflows/localization-candidate-pipeline.yml",
  );
  assert.equal(source.event, "workflow_dispatch");
  assert.equal(source.head_branch, "main");
  assert.equal(source.status, "completed");
  assert.equal(source.conclusion, "success");
  for (const stage of ["sql", "image", "push"]) {
    const matches = jobs.filter((j) =>
      j.name.startsWith(`target (${pin.target}, `) &&
      j.name.endsWith(` / ${stage}`)
    );
    assert.equal(
      matches.length,
      1,
      `Missing/ambiguous successful ${stage}: ${pin.target}`,
    );
    assert.equal(matches[0].status, "completed");
    assert.equal(matches[0].conclusion, "success");
  }
  for (const [key, value] of Object.entries(pin.artifact)) {
    assert.equal(artifact[key], value, `Artifact ${key} changed`);
  }
  assert.equal(artifact.expired, false);
  assert.equal(artifact.workflow_run?.id, pin.runId);
  assert.equal(artifact.workflow_run?.head_sha, pin.commit);
  assert.equal(artifact.workflow_run?.repository_id, source.repository.id);
  assert.equal(artifact.workflow_run?.head_repository_id, source.repository.id);
}
export async function planRelease(output) {
  const producer = pipelineProducer(),
    pins = validatePins(inputPins),
    cache = new Map();
  for (const pin of pins) {
    if (!cache.has(pin.runId)) {
      const source = await api(`actions/runs/${pin.runId}`);
      const jobs = await api(
        `actions/runs/${pin.runId}/attempts/${pin.attempt}/jobs?per_page=100`,
      );
      assert.ok(jobs.total_count <= 100, "Refuse truncated job inventory");
      cache.set(pin.runId, { source, jobs: jobs.jobs });
    }
    const { source, jobs } = cache.get(pin.runId);
    validateSource(
      pin,
      source,
      jobs,
      await api(`actions/artifacts/${pin.artifact.id}`),
    );
  }
  await writeJson(output, { producer, pins });
  await appendFile(
    process.env.GITHUB_OUTPUT,
    `sources=${JSON.stringify(pins)}\nplan_sha256=${await fileHash(output)}\n`,
  );
}
export function releaseTag(producer) {
  for (const n of [producer.runId, producer.attempt]) {
    assert.match(n ?? "", /^[1-9][0-9]{0,19}$/);
  }
  return `candidate-all12-r${producer.runId}-a${producer.attempt}`;
}
export async function releaseInputs(plan, input) {
  assert.deepEqual(plan.producer, pipelineProducer());
  assert.deepEqual(plan.pins, inputPins);
  validatePins(plan.pins);
  const inputs = [], bundles = [];
  for (const p of plan.pins) {
    const sql = join(input, p.target), b = await json(join(sql, "bundle.json"));
    assert.deepEqual(b.producer, {
      commit: p.commit,
      runId: String(p.runId),
      attempt: String(p.attempt),
    });
    assert.equal(b.target.id, p.target);
    bundles.push(b);
    inputs.push({
      target: p.target,
      sql,
      bundleSha256: await fileHash(join(sql, "bundle.json")),
    });
  }
  releaseCatalog(bundles); // Requires every version and component, never an implicit subset.
  return { inputs, bundles };
}
export async function buildRelease(
  { plan, planSha256, input, output, restore = true },
) {
  const producer = pipelineProducer();
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  localDockerOnly();
  assert.match(planSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(await fileHash(plan), planSha256);
  const pinned = await json(plan),
    { inputs, bundles } = await releaseInputs(pinned, input);
  const composed = await composeReleaseContext({ inputs, output });
  const tag = releaseTag(producer),
    localTag = `applelocalization-data-candidate:${tag}`;
  assert.ok(
    !(await docker("image", "ls", "--format", "{{.Repository}}:{{.Tag}}"))
      .split("\n").includes(localTag),
  );
  const nonce = randomBytes(16).toString("hex"),
    name = `localization-${tag}`,
    volume = name + "-data";
  assert.ok(
    !(await docker("ps", "-a", "--format", "{{.Names}}")).split("\n").includes(
      name,
    ),
  );
  assert.ok(
    !(await docker("volume", "ls", "--format", "{{.Name}}")).split("\n")
      .includes(volume),
  );
  const verification = join(output, "verification");
  await mkdir(verification);
  const disk = [], memory = [];
  const capacity = async (stage) => {
    // Docker's data root may be on another filesystem; protect both.
    const root = await docker("info", "--format", "{{.DockerRootDir}}");
    const paths = [...new Set([output, root])];
    for (const path of paths) {
      const fs = await statfs(path), free = fs.bavail * fs.bsize;
      disk.push({ stage, path, freeBytes: free });
      assert.ok(
        free >= 10 * 1024 ** 3,
        "Unified DB disk reserve exhausted; no push. See capacity.json.",
      );
    }
  };
  let created = false, built;
  const inspect = async () => {
    const [c] = JSON.parse(await docker("inspect", name));
    assert.equal(c.Image, built.Id);
    assert.equal(c.Config.Labels["org.applelocalization.nonce"], nonce);
    assert.equal(
      c.Config.Labels["org.applelocalization.bundle"],
      composed.identity,
    );
    assert.equal(c.HostConfig.NetworkMode, "none");
    assert.ok(
      c.Mounts.some((m) =>
        m.Type === "volume" && m.Name === volume &&
        m.Destination === "/var/lib/postgresql/data"
      ),
    );
    return c;
  };
  const ready = async () => {
    for (let i = 0; i < 1440; i++) {
      await capacity("restore");
      const c = await inspect();
      assert.equal(c.State.Running, true, "Unified DB exited during restore");
      if (i % 12 === 0) {
        // Child processes may be OOM-killed while Docker's main PID survives.
        const counters = await docker(
          "exec",
          name,
          "sh",
          "-c",
          "cat /sys/fs/cgroup/memory.events /sys/fs/cgroup/memory.current /sys/fs/cgroup/memory.max",
        ).catch(() => "unavailable");
        memory.push({ sampledAt: new Date().toISOString(), counters });
        console.log(
          JSON.stringify({
            status: "unified-db-restoring",
            freeBytes: disk.at(-1).freeBytes,
            memory: counters,
          }),
        );
      }
      if (c.State.Health?.Status === "healthy") return;
      await delay(5000);
    }
    throw Error("Unified DB initialization exceeded 120 minutes");
  };
  const processSQL = () =>
    spawn("docker", [
      "exec",
      "-i",
      name,
      "psql",
      "-X",
      "-q",
      "-U",
      "postgres",
      "-d",
      composed.catalog.database,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = (sql) => psqlLines(sql, processSQL);
  const query = async (sql) => {
    const out = [];
    for await (const line of lines(sql)) out.push(line);
    return out;
  };
  try {
    await capacity("before-build");
    await stream("docker", ["pull", "--platform=linux/amd64", baseImage]);
    await stream("docker", [
      "build",
      "--pull=false",
      "--network=none",
      "--platform=linux/amd64",
      "--provenance=false",
      "--load",
      "--build-arg",
      `BASE_IMAGE=${baseImage}`,
      "--label",
      `org.applelocalization.bundle=${composed.identity}`,
      "--tag",
      localTag,
      composed.context,
    ]);
    [built] = JSON.parse(await docker("image", "inspect", localTag));
    assert.match(built.Id, /^sha256:[a-f0-9]{64}$/);
    if (!restore) {
      // Publication of this candidate is explicitly NOT evidence of unified startup.
      const receipt = {
        status: "unified-candidate-assembled-restore-pending",
        producer,
        tag,
        localTag,
        image: built.Id,
        identity: composed.identity,
        baseImage,
        planSha256,
        catalog: composed.catalog,
        catalogSha256: await fileHash(
          join(composed.context, "payload/release-set.json"),
        ),
        components: bundles.flatMap((b) => b.components).length,
        imageBytes: built.Size,
        priorPerVersionFullAuditReused: true,
        unifiedRestoreVerified: false,
        cleanRestartVerified: false,
        countsAndSearchVerified: false,
        apiCompatible: false,
        productionReady: false,
        productionDeployed: false,
      };
      validateAssembled(receipt, producer);
      await writeJson(join(output, "assembled.json"), receipt);
      await appendFile(
        process.env.GITHUB_OUTPUT,
        `assembled_sha256=${await fileHash(join(output, "assembled.json"))}\n`,
      );
      return;
    }
    await docker(
      "volume",
      "create",
      "--label",
      `org.applelocalization.nonce=${nonce}`,
      volume,
    );
    await docker(
      "run",
      "-d",
      "--pull=never",
      "--platform=linux/amd64",
      "--name",
      name,
      "--network=none",
      "--restart=no",
      "--memory=5g",
      "--shm-size=256m",
      "--health-start-period=120m",
      "--health-timeout=60s",
      "--label",
      `org.applelocalization.nonce=${nonce}`,
      "--mount",
      `type=volume,source=${volume},target=/var/lib/postgresql/data`,
      "-e",
      `POSTGRES_DB=${composed.catalog.database}`,
      "-e",
      `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}`,
      built.Id,
    );
    created = true;
    await ready();
    const components = bundles.flatMap((b) => b.components);
    const schemas = await query(
      "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'localization_%' ORDER BY nspname;",
    );
    assert.deepEqual(schemas, components.map((c) => c.schema).sort());
    const searches = [];
    for (const c of components) {
      await capacity(c.key);
      const counts = await query(
        `SELECT (SELECT count(*) FROM ${c.schema}.occurrence),(SELECT count(*) FROM ${c.schema}.language),(SELECT count(*) FROM ${c.schema}.quarantine);`,
      );
      assert.deepEqual(counts, [
        `${c.rows}|${c.languageProfiles}|${c.quarantinedFiles}`,
      ]);
      const search = await verifyCandidateSearch({ component: c, lines });
      searches.push(search);
      await writeJson(join(verification, `${c.key}-search.json`), search);
      console.log(
        JSON.stringify({
          component: c.key,
          status: "restored-counts-and-search-verified",
        }),
      );
    }
    const [databaseBytes] = await query(
      "SELECT pg_database_size(current_database());",
    );
    await docker("stop", "--time", "60", name);
    assert.equal((await inspect()).State.ExitCode, 0);
    await docker("start", name);
    await ready();
    for (const [i, c] of components.entries()) {
      assert.deepEqual(
        await verifyCandidateSearch({ component: c, lines }),
        searches[i],
      );
    }
    assert.equal(
      (await docker("logs", name)).split(
        "Localization bundle: initialization completed.",
      ).length - 1,
      1,
    );
    await docker("stop", "--time", "60", name);
    assert.equal((await inspect()).State.ExitCode, 0);
    const receipt = {
      status: "unified-candidate-restore-verified-not-deployed",
      producer,
      tag,
      localTag,
      image: built.Id,
      identity: composed.identity,
      baseImage,
      planSha256,
      catalog: composed.catalog,
      databaseBytes: Number(databaseBytes),
      imageBytes: built.Size,
      components: components.length,
      cleanRestartVerified: true,
      countsAndSearchVerified: true,
      priorPerVersionFullAuditReused: true,
      allRowsReaudited: false,
      apiCompatible: false,
      productionReady: false,
      productionDeployed: false,
    };
    await writeJson(join(output, "verified.json"), receipt);
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `verified_sha256=${await fileHash(join(output, "verified.json"))}\n`,
    );
  } finally {
    await writeJson(join(output, "capacity.json"), disk);
    if (created) {
      const c = await inspect();
      if (c.State.Running) await docker("stop", "--time", "60", name);
      // Preserve the owned volume for inspection until the hosted runner is destroyed.
      const state = (await inspect()).State;
      await writeJson(join(output, "diagnostics.json"), {
        state: state.Status,
        exitCode: state.ExitCode,
        oomKilled: state.OOMKilled,
        memory,
        logs: await restoreLogs(name),
        componentsExpected: batch.jobs.length,
      });
    }
  }
}
export function validateVerified(d, producer) {
  assert.equal(d.status, "unified-candidate-restore-verified-not-deployed");
  assert.deepEqual(d.producer, producer);
  assert.equal(d.tag, releaseTag(producer));
  assert.equal(d.localTag, `applelocalization-data-candidate:${d.tag}`);
  assert.equal(d.baseImage, baseImage);
  assert.match(d.image, /^sha256:[a-f0-9]{64}$/);
  assert.match(d.identity, /^[a-f0-9]{64}$/);
  assert.equal(d.components, batch.jobs.length);
  assert.equal(d.catalog.allPlannedTargets, true);
  assert.deepEqual(d.catalog.missingTargets, []);
  assert.deepEqual(d.catalog.datasets.map((x) => x.id), releaseTargets());
  assert.equal(d.cleanRestartVerified, true);
  assert.equal(d.countsAndSearchVerified, true);
  for (
    const key of ["apiCompatible", "productionReady", "productionDeployed"]
  ) assert.equal(d[key], false);
}
export function validateAssembled(d, producer) {
  assert.equal(d.status, "unified-candidate-assembled-restore-pending");
  assert.deepEqual(d.producer, producer);
  assert.equal(d.tag, releaseTag(producer));
  assert.equal(d.localTag, `applelocalization-data-candidate:${d.tag}`);
  assert.equal(d.baseImage, baseImage);
  assert.match(d.image, /^sha256:[a-f0-9]{64}$/);
  assert.match(d.catalogSha256, /^[a-f0-9]{64}$/);
  assert.equal(
    d.catalogSha256,
    sha256(JSON.stringify(d.catalog, null, 2) + "\n"),
  );
  assert.equal(d.identity, sha256(JSON.stringify(d.catalog)));
  assert.equal(d.components, batch.jobs.length);
  validateReleaseDatabase(d.catalog.database);
  assert.equal(d.catalog.searchScope, "one-platform-major-version");
  assert.equal(d.catalog.allPlannedTargets, true);
  assert.deepEqual(d.catalog.missingTargets, []);
  assert.deepEqual(d.catalog.datasets.map((x) => x.id), releaseTargets());
  for (const dataset of d.catalog.datasets) {
    const target = batch.targets.find((x) => x.id === dataset.id);
    for (const key of ["platform", "version", "build"]) {
      assert.equal(dataset[key], target[key]);
    }
    assert.deepEqual(
      dataset.components.map(({ key, schema }) => ({ key, schema })),
      batch.jobs.filter((c) => c.target === target.id).map((
        { key, schema },
      ) => ({ key, schema })),
    );
  }
  assert.equal(d.priorPerVersionFullAuditReused, true);
  for (
    const key of [
      "unifiedRestoreVerified",
      "cleanRestartVerified",
      "countsAndSearchVerified",
      "apiCompatible",
      "productionReady",
      "productionDeployed",
    ]
  ) assert.equal(d[key], false);
}
export async function pushRelease(
  { input, sha256, output, allowPush, allowUnrestoredCandidate = false },
) {
  assert.equal(allowPush, true);
  localDockerOnly();
  assert.match(sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(await fileHash(input), sha256);
  const d = await json(input);
  if (allowUnrestoredCandidate) validateAssembled(d, pipelineProducer());
  else validateVerified(d, pipelineProducer());
  const [built] = JSON.parse(await docker("image", "inspect", d.localTag));
  assert.equal(built.Id, d.image);
  assert.equal(built.Config.Labels["org.applelocalization.bundle"], d.identity);
  const response = await fetch(
    `https://hub.docker.com/v2/repositories/kishikawakatsumi/applelocalization-data/tags/${d.tag}/`,
    { signal: AbortSignal.timeout(30000) },
  );
  assert.equal(
    response.status,
    404,
    "Tag exists or absence is unknown; refuse overwrite",
  );
  const destination = `${imageRepository}:${d.tag}`;
  await docker("tag", d.image, destination);
  await stream("docker", ["push", destination]);
  const [pushed] = JSON.parse(await docker("image", "inspect", destination));
  const digest = pushed.RepoDigests.find((s) =>
    /^(docker\.io\/)?kishikawakatsumi\/applelocalization-data@sha256:[a-f0-9]{64}$/
      .test(s)
  );
  assert.ok(digest);
  await writeJson(output, {
    status: allowUnrestoredCandidate
      ? "unified-candidate-pushed-restore-pending"
      : "unified-candidate-pushed-not-deployed",
    image: destination,
    imageId: d.image,
    digest,
    producer: d.producer,
    identity: d.identity,
    ...(allowUnrestoredCandidate
      ? {
        catalogSha256: d.catalogSha256,
        unifiedRestoreVerified: false,
        assembledSha256: sha256,
      }
      : { unifiedRestoreVerified: true, verifiedSha256: sha256 }),
    productionDeployed: false,
    apiCompatible: false,
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values: v } = parseArgs({
    options: {
      ...Object.fromEntries(
        ["mode", "plan", "plan-sha256", "input", "output", "sha256"].map((
          k,
        ) => [k, { type: "string" }]),
      ),
      "allow-push": { type: "boolean", default: false },
      "allow-unrestored-candidate": { type: "boolean", default: false },
    },
  });
  if (v.mode === "plan") await planRelease(v.output);
  else if (v.mode === "build" || v.mode === "assemble") {
    await buildRelease({
      ...v,
      planSha256: v["plan-sha256"],
      restore: v.mode === "build",
    });
  } else {
    assert.equal(v.mode, "push");
    await pushRelease({
      ...v,
      allowPush: v["allow-push"],
      allowUnrestoredCandidate: v["allow-unrestored-candidate"],
    });
  }
}
