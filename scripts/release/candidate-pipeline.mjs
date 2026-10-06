// Trusted Actions artifacts -> per-version SQL bundle. Never connects to production.
import assert from "node:assert/strict";
import { bundleDatabase, releaseDatabase } from "../database/database-name.mjs";
import { execFile } from "node:child_process";
import { appendFile, mkdir, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { fileHash, writeJson } from "../shared/collection-checkpoints.mjs";
import { validateBatchPlan } from "../collection/collect-release-batch.mjs";
import { verifyReleaseAssets } from "../package/verify-release-assets.mjs";
import { prepareDurableReleaseSQL } from "../database/export-release-sql.mjs";
import { auditOccurrenceSQL } from "../database/audit-occurrence-sql.mjs";

export const repository = "kishikawakatsumi/applelocalization-web";
export const batch = JSON.parse(
  await readFile(new URL("../plans/collection-batch-20261002.json", import.meta.url)),
);
validateBatchPlan(batch);
const execute = promisify(execFile);
const json = async (p) => JSON.parse(await readFile(p));
const api = async (path) =>
  JSON.parse(
    (await execute("gh", ["api", `repos/${repository}/${path}`], {
      maxBuffer: 16 * 1024 ** 2,
      timeout: 60000,
    })).stdout,
  );
export function pipelineProducer(env = process.env) {
  assert.equal(env.GITHUB_ACTIONS, "true");
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REPOSITORY, repository);
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.match(env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  for (const name of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
    assert.match(env[name] ?? "", /^[1-9][0-9]{0,19}$/);
  }
  return {
    commit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
  };
}
export function selectCandidateTargets(
  { run, jobs, artifacts, targets = "all-ready" },
) {
  assert.equal(run.repository?.full_name, repository);
  assert.equal(run.head_repository?.full_name, repository);
  assert.equal(run.head_repository?.id, run.repository?.id);
  assert.ok(Number.isSafeInteger(run.repository?.id));
  assert.equal(run.path, ".github/workflows/localization-release-batch.yml");
  assert.equal(run.event, "workflow_dispatch");
  assert.equal(run.head_branch, "main");
  assert.match(run.head_sha, /^[a-f0-9]{40}$/);
  assert.ok(Number.isSafeInteger(run.id) && run.id > 0);
  assert.ok(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0);
  assert.ok(["in_progress", "completed"].includes(run.status));
  // Successful extraction/upload remains reusable if optional SQL or a sibling job fails later.
  const requested = targets === "all-ready"
    ? batch.targets.map((t) => t.id)
    : targets.split(",");
  assert.equal(new Set(requested).size, requested.length);
  for (const id of requested) {
    assert.ok(batch.targets.some((t) => t.id === id), "Unknown target");
  }
  const ready = [], pending = [];
  for (const id of requested) {
    const target = batch.targets.find((t) => t.id === id),
      components = batch.jobs.filter((j) => j.target === id),
      pins = [];
    let reason = components.length
      ? ""
      : "alternative acquisition route pending";
    for (const component of components) {
      const matching = jobs.filter((j) =>
        j.name === `collect (${component.key})`
      );
      const stages = [
        "Extract and audit all collected languages; keep quarantine originals",
        "Save intermediate before SQL generation",
      ];
      if (
        matching.length !== 1 || !stages.every((name) => {
          const steps = matching[0].steps?.filter((s) => s.name === name) ?? [];
          return steps.length === 1 && steps[0].status === "completed" &&
            steps[0].conclusion === "success";
        })
      ) {
        reason = `component not successful: ${component.key}`;
        break;
      }
      const name = `intermediate-${component.key}-${run.id}-${run.run_attempt}`;
      const found = artifacts.filter((a) => a.name === name);
      if (found.length !== 1) {
        reason = `artifact unavailable: ${name}`;
        break;
      }
      const a = found[0];
      assert.equal(a.expired, false);
      assert.match(a.digest, /^sha256:[a-f0-9]{64}$/);
      assert.ok(Number.isSafeInteger(a.id) && a.id > 0);
      assert.ok(
        a.size_in_bytes > 0 && a.size_in_bytes < 2 * 1024 ** 3 + 16 * 1024 ** 2,
      );
      assert.equal(a.workflow_run?.id, run.id);
      assert.equal(a.workflow_run?.head_sha, run.head_sha);
      assert.equal(a.workflow_run?.repository_id, run.repository.id);
      assert.equal(a.workflow_run?.head_repository_id, run.repository.id);
      pins.push({
        ...component,
        artifact: {
          id: a.id,
          name: a.name,
          bytes: a.size_in_bytes,
          digest: a.digest,
        },
      });
    }
    if (reason) pending.push({ id, reason });
    else ready.push({ target, components: pins });
  }
  if (targets !== "all-ready") {
    assert.equal(pending.length, 0, JSON.stringify(pending));
  }
  assert.ok(
    ready.length,
    "No complete target is ready; wait for all required component jobs, never publish a partial target",
  );
  return {
    formatVersion: 1,
    source: {
      repository,
      runId: run.id,
      attempt: run.run_attempt,
      commit: run.head_sha,
      repositoryId: run.repository.id,
    },
    ready,
    pending,
    completeOS: false,
    published: false,
  };
}
export async function planCandidates({ sourceRun, targets, output }) {
  pipelineProducer();
  assert.match(sourceRun ?? "", /^[1-9][0-9]{0,19}$/);
  const run = await api(`actions/runs/${sourceRun}`);
  const [jobs, artifacts] = await Promise.all([
    api(
      `actions/runs/${sourceRun}/attempts/${run.run_attempt}/jobs?per_page=100`,
    ),
    api(`actions/runs/${sourceRun}/artifacts?per_page=100`),
  ]);
  assert.ok(
    jobs.total_count <= 100 && artifacts.total_count <= 100,
    "Pagination required; refuse incomplete inventory",
  );
  const plan = selectCandidateTargets({
    run,
    jobs: jobs.jobs,
    artifacts: artifacts.artifacts,
    targets,
  });
  await writeJson(output, plan);
  console.log(
    JSON.stringify({
      ready: plan.ready.map((t) => t.target.id),
      pending: plan.pending,
    }),
  );
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `matrix=${
        JSON.stringify({
          include: plan.ready.map((t) => ({
            target: t.target.id,
            artifact_ids: t.components.map((c) => c.artifact.id).join(","),
          })),
        })
      }\nsha256=${await fileHash(output)}\n`,
    );
  }
  return plan;
}
export async function loadPlan(path, sha256, target) {
  assert.match(sha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(await fileHash(path), sha256);
  const plan = await json(path),
    selected = plan.ready.find((t) => t.target.id === target);
  assert.ok(selected, "Target absent from pinned plan");
  assert.deepEqual(selected.target, batch.targets.find((t) => t.id === target));
  assert.deepEqual(
    selected.components.map(({ artifact, ...c }) => c),
    batch.jobs.filter((c) => c.target === target),
  );
  return { plan, selected };
}
// download-artifact v8 flattens a single ID, even with merge-multiple:false.
// Multiple IDs retain their artifact-name directories. Never guess a fallback
// when one member of a multi-component download is missing.
export async function candidateArtifactRoots(selected, input) {
  const components = selected.components;
  assert.ok(components.length > 0);
  const single = components.length === 1;
  assert.deepEqual(
    (await readdir(input)).sort(),
    single
      ? ["assets", "collection.json"]
      : components.map((c) => c.artifact.name).sort(),
    "Unexpected intermediate artifact layout",
  );
  return components.map((c) => single ? input : join(input, c.artifact.name));
}
export async function unpackCandidate({ plan, selected, input, output }) {
  const roots = await candidateArtifactRoots(selected, input);
  await mkdir(output);
  for (const [index, c] of selected.components.entries()) {
    const root = roots[index],
      receipt = await json(join(root, "collection.json"));
    assert.deepEqual((await readdir(root)).sort(), [
      "assets",
      "collection.json",
    ]);
    assert.equal(receipt.status, "batch-component-intermediate-verified");
    assert.equal(receipt.key, c.key);
    assert.deepEqual(receipt.input, c.input);
    assert.equal(receipt.collectorRepository, repository);
    assert.equal(receipt.collectorCommit, plan.source.commit);
    assert.equal(String(receipt.runId), String(plan.source.runId));
    assert.equal(String(receipt.runAttempt), String(plan.source.attempt));
    const result = await verifyReleaseAssets({
      input: join(root, "assets"),
      output: join(output, c.key),
      artifactSha256: receipt.artifactSha256,
    });
    assert.equal(result.sourceId, receipt.sourceId);
    assert.equal(result.manifestSha256, receipt.manifestSha256);
    const manifest = await json(join(output, c.key, "release.json"));
    assert.deepEqual(manifest.provenance.acquisition, c.input);
    assert.equal(manifest.provenance.collectorCommit, plan.source.commit);
    assert.equal(result.releaseFormatVersion, 2);
  }
}
export async function prepareCandidateSQL(
  { plan: planPath, planSha256, target, input, output },
) {
  const producer = pipelineProducer(),
    { plan, selected } = await loadPlan(planPath, planSha256, target);
  output = resolve(output);
  await mkdir(output);
  const release = join(output, "release");
  await unpackCandidate({ plan, selected, input, output: release });
  const sql = join(output, "sql");
  await mkdir(sql);
  const components = [];
  for (const c of selected.components) {
    const manifestSha256 = await fileHash(join(release, c.key, "release.json"));
    const result = await prepareDurableReleaseSQL({
      input: join(release, c.key),
      output: join(sql, c.key),
      manifestSha256,
      schema: c.schema,
      database: releaseDatabase,
      progress: (x) =>
        console.log(JSON.stringify({ component: c.key, progress: x })),
    });
    components.push({
      key: c.key,
      schema: c.schema,
      sourceId: result.sourceId,
      manifestSha256,
      packageManifest: result.packageManifest,
      sqlSha256: result.sqlSha256,
      sqlReportSha256: result.sqlReportSha256,
      rows: result.stats.rows,
      languageProfiles: result.languageProfiles,
      quarantinedFiles: result.quarantinedFiles,
    });
  }
  await writeJson(join(sql, "bundle.json"), {
    formatVersion: 1,
    status: "candidate-sql-bundle-verified",
    database: releaseDatabase,
    producer,
    source: plan.source,
    target: selected.target,
    planSha256,
    components,
    apiCompatible: false,
    productionReady: false,
    completeOS: false,
    published: false,
  });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `bundle_sha256=${await fileHash(join(sql, "bundle.json"))}\n`,
    );
  }
}
export async function verifyCandidateSQL(
  { plan: planPath, planSha256, target, sql, bundleSha256, releases },
) {
  const { plan, selected } = await loadPlan(planPath, planSha256, target);
  assert.match(bundleSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(await fileHash(join(sql, "bundle.json")), bundleSha256);
  const bundle = await json(join(sql, "bundle.json"));
  assert.equal(bundle.status, "candidate-sql-bundle-verified");
  assert.deepEqual(bundle.target, selected.target);
  assert.deepEqual(bundle.source, plan.source);
  assert.equal(bundle.planSha256, planSha256);
  assert.deepEqual(
    bundle.components.map((c) => c.key),
    selected.components.map((c) => c.key),
  );
  assert.deepEqual(
    (await readdir(sql)).sort(),
    ["bundle.json", ...bundle.components.map((c) => c.key)].sort(),
  );
  for (const c of bundle.components) {
    const expected = selected.components.find((x) => x.key === c.key);
    assert.equal(c.schema, expected.schema);
    assert.deepEqual((await readdir(join(sql, c.key))).sort(), [
      "import.sql.gz",
      "report.json",
      "verification.json",
    ]);
    const report = await json(join(sql, c.key, "report.json")),
      verification = await json(join(sql, c.key, "verification.json"));
    assert.equal(
      await fileHash(join(sql, c.key, "report.json")),
      c.sqlReportSha256,
    );
    assert.equal(
      await fileHash(join(sql, c.key, "import.sql.gz")),
      c.sqlSha256,
    );
    assert.equal(report.schema, c.schema);
    assert.equal(report.packageManifest, c.packageManifest);
    assert.equal(report.database, bundleDatabase(bundle));
    assert.equal(verification.releaseManifestSha256, c.manifestSha256);
    assert.equal(verification.sourceId, c.sourceId);
    assert.equal(
      await fileHash(join(releases, c.key, "release.json")),
      c.manifestSha256,
    );
    const audit = await auditOccurrenceSQL({
      input: join(releases, c.key, "package"),
      sql: join(sql, c.key),
      packageManifest: c.packageManifest,
      durable: true,
      database: bundleDatabase(bundle),
    });
    assert.equal(audit.sqlSha256, c.sqlSha256);
    assert.equal(audit.sqlReportSha256, c.sqlReportSha256);
    assert.equal(audit.stats.rows, c.rows);
    assert.equal(audit.languageProfiles, c.languageProfiles);
    assert.equal(audit.quarantinedFiles, c.quarantinedFiles);
  }
  return bundle;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values: v } = parseArgs({
    options: Object.fromEntries(
      [
        "mode",
        "source-run",
        "targets",
        "output",
        "plan",
        "plan-sha256",
        "target",
        "input",
      ].map((k) => [k, { type: "string" }]),
    ),
  });
  if (v.mode === "plan") {
    await planCandidates({
      sourceRun: v["source-run"],
      targets: v.targets,
      output: v.output,
    });
  } else {
    assert.equal(v.mode, "sql");
    await prepareCandidateSQL({ ...v, planSha256: v["plan-sha256"] });
  }
}
