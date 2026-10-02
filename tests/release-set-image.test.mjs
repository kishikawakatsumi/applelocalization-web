import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { batch, repository } from "../scripts/candidate-pipeline.mjs";
import { baseImage } from "../scripts/candidate-bundle-image.mjs";
import { releaseTargets } from "../scripts/compose-release-set.mjs";
import {
  inputPins,
  releaseTag,
  summarizeRestoreLogs,
  validatePins,
  validateSource,
  validateVerified,
} from "../scripts/release-set-image.mjs";

test("restore diagnostics preserve PostgreSQL stderr errors but omit SQL/COPY data", () => {
  const summary = summarizeRestoreLogs(
    "Localization component: ios27-os start\nCOPY 123\nprivate raw row\n",
    'psql:<stdin>:12345: ERROR:  could not extend file "base/123": No space left on device\n' +
      "2026-10-02 11:26:50.001 UTC [33] ERROR:  out of shared memory\n" +
      "2026-10-02 11:26:50.001 UTC [33] CONTEXT: COPY private raw row\n" +
      "2026-10-02 11:26:50.001 UTC [33] STATEMENT: SELECT 'secret'\n" +
      "2026-10-02 11:26:50.002 UTC [1] LOG:  server process (PID 33) was terminated by signal 9: Killed\n" +
      "psql:42: ERROR: invalid value 'secret text'\n",
  );
  assert.deepEqual(summary.components, [{ key: "ios27-os", status: "start" }]);
  assert.equal(summary.errors.length, 4);
  assert.ok(summary.errors.some((e) => e.includes("out of shared memory")));
  assert.ok(summary.errors.some((e) => e.includes("signal 9")));
  assert.ok(!JSON.stringify(summary).includes("private raw row"));
  assert.ok(!JSON.stringify(summary).includes("secret"));
  assert.ok(!JSON.stringify(summary).includes("base/123"));
  const bounded = summarizeRestoreLogs(
    "",
    ("psql:42: ERROR: " + "x".repeat(4096) + "\n").repeat(50),
  );
  assert.equal(bounded.errors.length, 30);
  assert.ok(bounded.errors.every((e) => e.length <= 1024));
});

function sourceFixture() {
  const pin = structuredClone(inputPins[0]),
    repo = { id: 450764065, full_name: repository };
  const source = {
    id: pin.runId,
    run_attempt: pin.attempt,
    head_sha: pin.commit,
    repository: repo,
    head_repository: { ...repo },
    path: ".github/workflows/localization-candidate-pipeline.yml",
    event: "workflow_dispatch",
    head_branch: "main",
    status: "completed",
    conclusion: "success",
  };
  const jobs = ["sql", "image", "push"].map((stage) => ({
    name: `target (${pin.target}, 123,456) / ${stage}`,
    status: "completed",
    conclusion: "success",
  }));
  const artifact = {
    ...pin.artifact,
    expired: false,
    workflow_run: {
      id: pin.runId,
      head_sha: pin.commit,
      repository_id: repo.id,
      head_repository_id: repo.id,
    },
  };
  return { pin, source, jobs, artifact };
}
test("all 12 SQL inputs are pinned to exact successful CI artifacts, in canonical order", () => {
  assert.equal(validatePins(inputPins).length, 12);
  assert.deepEqual(inputPins.map((p) => p.target), releaseTargets());
  for (
    const mutate of [
      (p) => p.pop(),
      (p) => p.reverse(),
      (p) => p[1] = p[0],
      (p) => p[0].commit = "main",
      (p) => p[0].artifact.digest = "unknown",
      (p) => p[0].artifact.id = -1,
      (p) => p[0].artifact.name = "candidate-sql-latest",
      (p) => p[0].artifact.size_in_bytes = 0,
    ]
  ) {
    const pins = structuredClone(inputPins);
    mutate(pins);
    assert.throws(() => validatePins(pins));
  }
});
test("intake rejects changed attempts, forks, failed or missing prior audits and replaced/expired SQL", () => {
  const valid = sourceFixture();
  validateSource(valid.pin, valid.source, valid.jobs, valid.artifact);
  for (
    const mutate of [
      (f) => f.source.id++,
      (f) => f.source.run_attempt++,
      (f) => f.source.head_sha = "0".repeat(40),
      (f) => f.source.repository.full_name = "fork/repo",
      (f) => f.source.head_repository.id++,
      (f) => f.source.path = ".github/workflows/untrusted.yml",
      (f) => f.source.event = "pull_request",
      (f) => f.source.head_branch = "feature",
      (f) => f.source.status = "in_progress",
      (f) => f.source.conclusion = "failure",
      (f) => f.jobs.pop(),
      (f) => f.jobs.push(f.jobs[0]),
      (f) => f.jobs[1].conclusion = "failure",
      (f) => f.jobs[0].status = "in_progress",
      (f) => f.artifact.expired = true,
      (f) => f.artifact.digest = "sha256:" + "0".repeat(64),
      (f) => f.artifact.size_in_bytes++,
      (f) => f.artifact.workflow_run.repository_id++,
      (f) => f.artifact.workflow_run.id++,
      (f) => f.artifact.workflow_run.head_sha = "0".repeat(40),
    ]
  ) {
    const f = sourceFixture();
    mutate(f);
    assert.throws(() => validateSource(f.pin, f.source, f.jobs, f.artifact));
  }
});
test("only same-run complete restored candidate can pass the pre-push gate", () => {
  const producer = { runId: "123", attempt: "1", commit: "a".repeat(40) },
    tag = releaseTag(producer);
  assert.equal(tag, "candidate-all12-r123-a1");
  const receipt = {
    status: "unified-candidate-restore-verified-not-deployed",
    producer,
    tag,
    localTag: `applelocalization-data-candidate:${tag}`,
    baseImage,
    image: "sha256:" + "b".repeat(64),
    identity: "c".repeat(64),
    components: batch.jobs.length,
    catalog: {
      allPlannedTargets: true,
      missingTargets: [],
      datasets: releaseTargets().map((id) => ({ id })),
    },
    cleanRestartVerified: true,
    countsAndSearchVerified: true,
    apiCompatible: false,
    productionReady: false,
    productionDeployed: false,
  };
  validateVerified(receipt, producer);
  for (
    const mutate of [
      (d) => d.tag = "latest",
      (d) => d.producer.runId = "124",
      (d) => d.producer.attempt = "2",
      (d) => d.status = "unverified",
      (d) => d.image = "latest",
      (d) => d.components--,
      (d) => d.catalog.allPlannedTargets = false,
      (d) => d.catalog.missingTargets.push("ios15"),
      (d) => d.catalog.datasets.pop(),
      (d) => d.cleanRestartVerified = false,
      (d) => d.countsAndSearchVerified = false,
      (d) => d.productionReady = true,
      (d) => d.baseImage = "groonga/pgroonga:latest",
    ]
  ) {
    const d = structuredClone(receipt);
    mutate(d);
    assert.throws(() => validateVerified(d, producer));
  }
  assert.throws(() => releaseTag({ runId: "latest", attempt: "1" }));
});
test("workflow downloads pinned SQL and explicitly publishes only an assembled restore-pending candidate", async () => {
  const yaml = await readFile(
    new URL(
      "../.github/workflows/localization-unified-candidate.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.equal((yaml.match(/digest-mismatch: error/g) ?? []).length, 12);
  for (const [i, pin] of inputPins.entries()) {
    assert.ok(
      yaml.includes(`fromJSON(steps.plan.outputs.sources)[${i}].artifact.id`),
    );
    assert.ok(yaml.includes(`/sql/${pin.target}`));
  }
  assert.ok(
    yaml.indexOf("--mode assemble") < yaml.indexOf("docker/login-action"),
  );
  assert.ok(yaml.includes("assembled_sha256"));
  assert.ok(yaml.includes("--allow-unrestored-candidate"));
  assert.ok(!yaml.includes("--mode build"));
  assert.ok(!yaml.includes("verify-release-set-local.mjs"));
  assert.ok(!yaml.includes("localization-release-batch"));
  assert.ok(!yaml.includes("self-hosted"));
});
