import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  producer,
  runBatchComponent,
  validateBatchPlan,
} from "../../scripts/collection/collect-release-batch.mjs";

const plan = JSON.parse(
  await readFile(
    new URL("../../scripts/plans/collection-batch-20261002.json", import.meta.url),
  ),
);
test("batch accounts for all 12 series, 5 IPSW and 7 full-OTA targets with 36 components", () => {
  const matrix = validateBatchPlan(plan);
  assert.equal(matrix.include.length, 36);
  assert.equal(
    plan.targets.filter((x) => x.status === "ipsw-input-pinned").length,
    5,
  );
  assert.equal(
    plan.targets.filter((x) => x.status === "alternative-route-pending").length,
    0,
  );
  assert.deepEqual(plan.targets.map((x) => x.id), [
    "ios27",
    "ios26",
    "ios18",
    "ios17",
    "ios16",
    "ios15",
    "macos27",
    "macos26",
    "macos15",
    "macos14",
    "macos13",
    "macos12",
  ]);
  assert.deepEqual(
    plan.jobs.filter((x) => x.target === "ios15").map((x) => x.input.component),
    ["OS"],
  );
  assert.equal(
    plan.jobs.find((x) => x.key === "ios15-os").input.board,
    "d101ap",
  );
  assert.equal(
    plan.jobs.find((x) => x.key === "ios16-os").input.board,
    "d221ap",
  );
  assert.ok(
    plan.jobs.find((x) => x.key === "macos27-os").uncollectedManifestComponents
      .includes("Cryptex1,RosettaOS"),
  );
});
test("batch rejects substituted releases, mislabelled components and unbounded inputs", () => {
  for (
    const mutate of [
      (p) => p.published = true,
      (p) => p.completeOS = true,
      (p) => p.targets.pop(),
      (p) => p.jobs[0].input.version = "26.1",
      (p) => p.jobs[0].input.build = "old",
      (p) => p.jobs[0].input.url = "https://example.com/image.ipsw",
      (p) => p.jobs[0].input.manifestSha256 = "unknown",
      (p) => p.jobs[0].input.maximumDownloadBytes = 13 * 1024 ** 3,
      (p) => p.jobs[0].input.maximumImageBytes = 17 * 1024 ** 3,
      (p) => p.jobs[0].key = "ios26-os",
      (p) => p.jobs[0].input.component = "RestoreRamDisk",
      (p) => p.jobs[0].schema = p.jobs[1].schema,
      (p) => p.jobs[0].completeOS = true,
      (p) =>
        p.targets.find((x) => x.id === "ios26").status = "ipsw-input-pinned",
      (p) => p.tool.archiveSha256 = "a".repeat(64),
      (p) => p.tool.archiveBytes = 0,
    ]
  ) {
    const changed = structuredClone(plan);
    mutate(changed);
    assert.throws(() => validateBatchPlan(changed));
  }
});
test("manual main producer and explicit download opt-in precede external side effects", async () => {
  const env = {
    GITHUB_ACTIONS: "true",
    GITHUB_EVENT_NAME: "workflow_dispatch",
    GITHUB_REPOSITORY: "kishikawakatsumi/applelocalization-web",
    GITHUB_REF: "refs/heads/main",
    GITHUB_SHA: "a".repeat(40),
    GITHUB_RUN_ID: "123",
    GITHUB_RUN_ATTEMPT: "1",
  };
  assert.equal(producer(env).runId, "123");
  for (const key of Object.keys(env)) {
    assert.throws(() => producer({ ...env, [key]: "invalid" }));
  }
  await assert.rejects(
    runBatchComponent({ mode: "collect" }),
    /Explicit download approval/,
  );
});
test("workflow uploads intermediate before SQL, never publishes or uploads source images", async () => {
  const workflow = await readFile(
    new URL(
      "../../.github/workflows/localization-release-batch.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.ok(
    workflow.indexOf("name: Save intermediate") <
      workflow.indexOf("name: Generate logged SQL"),
  );
  assert.match(workflow, /max-parallel: 3/);
  assert.match(workflow, /fail-fast: false/);
  assert.match(workflow, /retention-days: 14/);
  assert.match(workflow, /contents: read/);
  // runner context is unavailable in job-level env; initialize via a step instead.
  assert.doesNotMatch(workflow, /\$\{\{ runner\.temp \}\}/);
  assert.match(workflow, /OUTPUT=\$RUNNER_TEMP\/localization-/);
  assert.ok(
    workflow.indexOf("name: Set component output") <
      workflow.indexOf("name: Extract and audit"),
  );
  assert.doesNotMatch(
    workflow,
    /secrets\.|contents: write|docker push|gh release|psql|\/work\/|\.dmg\b/,
  );
  assert.match(workflow, /assets\/localization-intermediate.tar/);
});
