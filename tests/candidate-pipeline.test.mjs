import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import {
  batch,
  candidateArtifactRoots,
  pipelineProducer,
  repository,
  selectCandidateTargets,
} from "../scripts/candidate-pipeline.mjs";
import {
  candidateTag,
  prepareBundleContext,
  pushCandidate,
  verifyCandidateDistribution,
  verifyCandidateSearch,
} from "../scripts/candidate-bundle-image.mjs";
import { selectBatchJobs } from "../scripts/collect-release-batch.mjs";
import {
  fileHash,
  sha256,
  treeHashes,
} from "../scripts/collection-checkpoints.mjs";
function fixture() {
  const run = {
    id: 123,
    run_attempt: 1,
    head_sha: "a".repeat(40),
    head_branch: "main",
    event: "workflow_dispatch",
    path: ".github/workflows/localization-release-batch.yml",
    status: "in_progress",
    repository: { id: 42, full_name: repository },
    head_repository: { id: 42, full_name: repository },
  };
  const jobs = batch.jobs.map((c) => ({
    name: `collect (${c.key})`,
    status: "completed",
    conclusion: "success",
    steps: [
      "Extract and audit all collected languages; keep quarantine originals",
      "Save intermediate before SQL generation",
    ].map((name) => ({ name, status: "completed", conclusion: "success" })),
  }));
  const artifacts = batch.jobs.map((c, i) => ({
    id: i + 10,
    name: `intermediate-${c.key}-123-1`,
    digest: "sha256:" + "b".repeat(64),
    expired: false,
    size_in_bytes: 100,
    workflow_run: {
      id: 123,
      head_sha: run.head_sha,
      repository_id: 42,
      head_repository_id: 42,
    },
  }));
  return { run, jobs, artifacts };
}
test("download layout follows single-ID flattening and keeps multi-ID components separate", async () => {
  const root = await mkdtemp(join(tmpdir(), "candidate-download-"));
  const single =
    selectCandidateTargets({ ...fixture(), targets: "ios15" }).ready[0];
  const multi =
    selectCandidateTargets({ ...fixture(), targets: "ios27" }).ready[0];
  const flat = join(root, "flat"), named = join(root, "named");
  await mkdir(join(flat, "assets"), { recursive: true });
  await writeFile(join(flat, "collection.json"), "{}");
  assert.deepEqual(await candidateArtifactRoots(single, flat), [flat]);
  await mkdir(named);
  for (const c of multi.components) await mkdir(join(named, c.artifact.name));
  assert.deepEqual(
    await candidateArtifactRoots(multi, named),
    multi.components.map((c) => join(named, c.artifact.name)),
  );
  await assert.rejects(
    candidateArtifactRoots(multi, flat),
    /Unexpected intermediate artifact layout/,
  );
  await assert.rejects(
    candidateArtifactRoots(single, named),
    /Unexpected intermediate artifact layout/,
  );
  await writeFile(join(flat, "unexpected.json"), "{}");
  await assert.rejects(
    candidateArtifactRoots(single, flat),
    /Unexpected intermediate artifact layout/,
  );
});
test("candidate plans all complete OS versions, never combines different runs or silently publishes partial targets", () => {
  const f = fixture(), plan = selectCandidateTargets(f);
  assert.equal(plan.ready.length, 12);
  assert.equal(plan.pending.length, 0);
  assert.equal(
    selectCandidateTargets({ ...f, targets: "ios15" }).ready[0].components
      .length,
    1,
  );
  f.jobs.find((j) => j.name === "collect (ios27-systemos)").steps[0]
    .conclusion = "failure";
  const partial = selectCandidateTargets(f);
  assert.equal(partial.ready.length, 11);
  assert.ok(partial.pending.some((p) => p.id === "ios27"));
  assert.throws(
    () => selectCandidateTargets({ ...f, targets: "ios27" }),
    /component not successful/,
  );
  assert.equal(
    selectCandidateTargets({ ...f, targets: "ios26" }).ready[0].components
      .length,
    3,
  );
});
test("successful intermediate upload survives a later optional SQL failure", () => {
  const f = fixture();
  f.jobs.find((j) => j.name === "collect (ios27-os)").conclusion = "failure";
  assert.equal(
    selectCandidateTargets({ ...f, targets: "ios27" }).ready.length,
    1,
  );
  f.jobs.find((j) => j.name === "collect (ios27-os)").steps[1].conclusion =
    "failure";
  assert.throws(() => selectCandidateTargets({ ...f, targets: "ios27" }));
});
test("artifact trust rejects forks, arbitrary producers, rerun mixing, damaged metadata and expired data", () => {
  for (
    const change of [
      (f) => f.run.head_branch = "feature",
      (f) => f.run.event = "pull_request",
      (f) => f.run.path = "untrusted.yml",
      (f) => f.run.head_repository.id = 99,
      (f) => f.run.head_sha = "main",
      (f) => f.run.repository.full_name = "other/repo",
      (f) => f.run.run_attempt = 2,
      (f) => f.artifacts[0].expired = true,
      (f) => f.artifacts[0].digest = "unknown",
      (f) => f.artifacts[0].workflow_run.head_sha = "c".repeat(40),
      (f) => f.artifacts[0].workflow_run.repository_id = 99,
      (f) => f.artifacts[0].size_in_bytes = 4 * 1024 ** 3,
    ]
  ) {
    const f = fixture();
    change(f);
    assert.throws(() => selectCandidateTargets({ ...f, targets: "ios27" }));
  }
  assert.throws(() =>
    selectCandidateTargets({ ...fixture(), targets: "ios27,ios27" })
  );
  assert.throws(() =>
    selectCandidateTargets({ ...fixture(), targets: "ios27;echo secret" })
  );
});
test("collection can be started independently for a pinned OS and unknown routes fail before download", () => {
  assert.equal(selectBatchJobs(batch, "ios27").include.length, 3);
  assert.equal(selectBatchJobs(batch, "ios15").include.length, 1);
  assert.equal(selectBatchJobs(batch, "ios26").include.length, 3);
  assert.throws(() => selectBatchJobs(batch, "ios27,ios27"));
});
test("push is explicit, main-only, version-specific, never latest", async () => {
  await assert.rejects(pushCandidate({}), /Explicit candidate push/);
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "456",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const p = pipelineProducer(env);
  assert.equal(
    candidateTag(batch.targets[0], p),
    "candidate-ios27-27.0.1-24a446-r456-a2",
  );
  for (const key of Object.keys(env)) {
    assert.throws(() => pipelineProducer({ ...env, [key]: "bad" }));
  }
  assert.throws(() =>
    candidateTag({ ...batch.targets[0], version: "26.1" }, p)
  );
});
async function sqlFixture(id = "ios27") {
  const root = await mkdtemp(join(tmpdir(), "candidate-bundle-")),
    sql = join(root, "sql");
  await mkdir(sql);
  const components = [];
  for (const c of batch.jobs.filter((j) => j.target === id)) {
    await mkdir(join(sql, c.key));
    await writeFile(
      join(sql, c.key, "import.sql.gz"),
      gzipSync("-- inert fixture, never executed"),
    );
    const report = {
      status: "durable-occurrence-sql-prepared",
      database: "localization_staging",
      schema: c.schema,
      storage: "logged",
      packageManifest: "b".repeat(64),
      sqlSha256: await fileHash(join(sql, c.key, "import.sql.gz")),
    };
    await writeFile(join(sql, c.key, "report.json"), JSON.stringify(report));
    const sqlReportSha256 = await fileHash(join(sql, c.key, "report.json"));
    await writeFile(
      join(sql, c.key, "verification.json"),
      JSON.stringify({
        ...report,
        status: "durable-release-sql-verified-not-imported",
        sqlReportSha256,
      }),
    );
    components.push({
      key: c.key,
      schema: c.schema,
      packageManifest: report.packageManifest,
      sqlSha256: report.sqlSha256,
      sqlReportSha256,
    });
  }
  const bundle = { target: batch.targets.find((t) => t.id === id), components };
  await writeFile(join(sql, "bundle.json"), JSON.stringify(bundle));
  return { sql, bundle, output: join(root, "context") };
}
test("bundle context keeps every component in separate schemas and copies only verified SQL payload", async () => {
  const f = await sqlFixture();
  await writeFile(join(f.sql, ".env"), "SECRET=fixture");
  const identity = await prepareBundleContext(f);
  assert.match(identity, /^[a-f0-9]{64}$/);
  assert.deepEqual(
    (await readdir(join(f.output, "payload"))).sort(),
    [
      "SHA256SUMS",
      "bundle.json",
      "dataset.env",
      "identity",
      "ios27-appos",
      "ios27-os",
      "ios27-systemos",
      "sources.tsv",
    ].sort(),
  );
  const mapping = await readFile(join(f.output, "payload/sources.tsv"), "utf8");
  for (const c of f.bundle.components) {
    assert.ok(mapping.includes(`${c.key}\t${c.schema}\t${c.packageManifest}`));
  }
  const init = await readFile(join(f.output, "initialize.sh"), "utf8");
  assert.match(init, /set -Eeuo pipefail/);
  assert.ok(init.indexOf("SHOW autovacuum") < init.indexOf("CREATE EXTENSION"));
  assert.match(init, /SHOW autovacuum'\)\" = off/);
  assert.match(
    await readFile(join(f.output, "healthcheck.sh"), "utf8"),
    /SHOW autovacuum'\)\" = on/,
  );
  assert.match(
    await readFile(join(f.output, "postgres-init-entrypoint.sh"), "utf8"),
    /-c autovacuum=off/,
  );
  assert.ok(init.indexOf("done <") < init.indexOf("localization-ready.tmp"));
  assert.match(
    await readFile(join(f.output, "localization-entrypoint.sh"), "utf8"),
    /incomplete or different dataset volume/,
  );
});
test("bundle context rejects missing component, mismatched schema and corrupted SQL", async () => {
  let f = await sqlFixture();
  f.bundle.components.pop();
  await assert.rejects(prepareBundleContext(f));
  f = await sqlFixture();
  await writeFile(
    join(f.sql, f.bundle.components[0].key, "import.sql.gz"),
    "corrupt",
  );
  await assert.rejects(prepareBundleContext(f));
  f = await sqlFixture();
  f.bundle.components[0].schema = "public";
  await assert.rejects(prepareBundleContext(f));
});
test("OTA bundle keeps OS, AppOS and both SystemOS architectures without merging contexts", async () => {
  const f = await sqlFixture("macos15");
  assert.equal(f.bundle.components.length, 4);
  await prepareBundleContext(f);
  const mapping = await readFile(join(f.output, "payload/sources.tsv"), "utf8");
  assert.equal(mapping.trim().split("\n").length, 4);
  assert.match(mapping, /localization_macos15_24h32_systemos_arm64e/);
  assert.match(mapping, /localization_macos15_24h32_systemos_x86_64/);
});
test("source-specific probes check all profiles without assuming pilot vocabulary or translations", async () => {
  const c = {
    schema: "localization_ios15_19h422_os",
    packageManifest: "a".repeat(64),
  };
  const lines = async function* (sql) {
    if (sql.includes("pg_get_indexdef")) {
      yield JSON.stringify([{
        relname: "key_idx",
        indisvalid: true,
        indisready: true,
        first_column: "key_text",
      }, {
        relname: "target_idx",
        indisvalid: true,
        indisready: true,
        first_column: "target_text",
      }]);
    } else if (sql.includes("l.expected_rows")) {
      yield JSON.stringify([{ id: 1, code: "en", sample_id: "1" }, {
        id: 2,
        code: "unknown",
        sample_id: null,
      }]);
    } else if (sql.includes("AS found")) yield '[{"found":true}]';
    else if (sql.includes("DISTINCT ON")) {
      yield '[{"id":1,"code":"en","target_text":"Hello"}]';
    } else if (sql.includes("EXPLAIN")) {
      yield '[{"Plan":{"Index Name":"target_idx"}}]';
    } else if (sql.includes("ids_sha256")) {
      yield '[{"count":"1","ids_sha256":"same"}]';
    } else yield "[]";
  };
  const result = await verifyCandidateSearch({ component: c, lines });
  assert.equal(result.profiles.length, 2);
  assert.equal(result.profiles[1].tested, false);
  assert.equal(result.measurements.length, 1);
});
test("candidate pipeline uses independent SQL, image, push jobs and no production deployment credentials", async () => {
  const workflow = await readFile(
    new URL(
      "../.github/workflows/localization-build-target.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(workflow, /needs: sql/);
  assert.match(workflow, /needs: image/);
  assert.match(workflow, /inputs.publish == true/);
  assert.ok(
    workflow.indexOf("Verify exact successful") <
      workflow.indexOf("docker/login-action"),
  );
  assert.doesNotMatch(
    workflow.slice(0, workflow.indexOf("  push:")),
    /secrets\./,
  );
  assert.doesNotMatch(
    workflow,
    /SSH_|:latest|docker system prune|contents: write/,
  );
  assert.match(workflow, /artifact-ids:/);
  assert.match(workflow, /digest-mismatch: error/);
});

test("publication boundary binds image bytes, full restore and exact target before any login", async () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: repository,
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "456",
    GITHUB_RUN_ATTEMPT: "2",
  };
  const previous = Object.fromEntries(
    Object.keys(env).map((k) => [k, process.env[k]]),
  );
  Object.assign(process.env, env);
  try {
    const input = await mkdtemp(join(tmpdir(), "candidate-distribution-"));
    await mkdir(join(input, "verification"));
    const c = {
      ...batch.jobs.find((j) => j.key === "ios15-os"),
      packageManifest: "b".repeat(64),
      rows: 1,
      languageProfiles: 1,
      quarantinedFiles: 0,
    };
    const producer = pipelineProducer(),
      bundle = {
        target: batch.targets.find((t) => t.id === "ios15"),
        source: { runId: 123 },
        components: [c],
      };
    const put = (path, value) =>
      writeFile(join(input, path), JSON.stringify(value));
    await put("bundle.json", bundle);
    await writeFile(join(input, "image.tar"), "inert fixture, never loaded");
    const image = "sha256:" + "c".repeat(64),
      identity = sha256(JSON.stringify(bundle));
    const result = {
      status: "candidate-bundle-restore-verified",
      image,
      identity,
      components: [c.key],
      allRowsAndQuarantineCompared: true,
      cleanRestartVerified: true,
      containerStopped: true,
    };
    await put("verification/result.json", result);
    await put(`verification/${c.key}-roundtrip.json`, {
      status: "database-full-roundtrip-verified",
      schema: c.schema,
      packageManifest: c.packageManifest,
      rows: 1,
      languages: 1,
      quarantinedFiles: 0,
    });
    await put(`verification/${c.key}-search.json`, {
      status: "candidate-search-verified",
      schema: c.schema,
      packageManifest: c.packageManifest,
      profiles: [{}],
    });
    const distribution = {
      status: "candidate-bundle-image-verified",
      producer,
      target: bundle.target,
      source: bundle.source,
      tag: candidateTag(bundle.target, producer),
      image,
      identity,
      baseImage:
        "groonga/pgroonga@sha256:841b25c58037c36d14f596c18b42e582d4d1672ae90484a440094ac7fa66e729",
      bundleSha256: await fileHash(join(input, "bundle.json")),
      files: await treeHashes(input),
      apiCompatible: false,
      productionReady: false,
      published: false,
    };
    const seal = async () => {
      const files = await treeHashes(input);
      delete files["distribution.json"];
      distribution.files = files;
      await put("distribution.json", distribution);
      return fileHash(join(input, "distribution.json"));
    };
    let hash = await seal();
    await verifyCandidateDistribution({ input, sha256: hash });
    await writeFile(join(input, "image.tar"), "tampered");
    await assert.rejects(verifyCandidateDistribution({ input, sha256: hash }));
    await put("verification/result.json", {
      ...result,
      cleanRestartVerified: false,
    });
    hash = await seal();
    await assert.rejects(verifyCandidateDistribution({ input, sha256: hash }));
    await put("verification/result.json", result);
    distribution.producer = { ...producer, runId: "999" };
    hash = await seal();
    await assert.rejects(verifyCandidateDistribution({ input, sha256: hash }));
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
});
