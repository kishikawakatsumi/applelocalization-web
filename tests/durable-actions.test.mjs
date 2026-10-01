import test from "node:test";
import assert from "node:assert/strict";
import {
  lstat,
  mkdtemp,
  readFile,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileHash } from "../scripts/collection-checkpoints.mjs";
import {
  distributionFiles,
  distributionTag,
  pilot,
  producer,
  publishActions,
  verifyDistribution,
} from "../scripts/durable-actions.mjs";
import { compareRestoreSearch } from "../scripts/rehearse-durable-docker.mjs";

const env = {
  GITHUB_ACTIONS: "true",
  GITHUB_EVENT_NAME: "workflow_dispatch",
  GITHUB_REPOSITORY: "kishikawakatsumi/applelocalization-web",
  GITHUB_REF: "refs/heads/main",
  GITHUB_SHA: "a".repeat(40),
  GITHUB_RUN_ID: "123",
  GITHUB_RUN_ATTEMPT: "1",
};
test("durable publication requires manual main-branch producer and explicit authority", async () => {
  assert.equal(
    distributionTag(producer(env)),
    "candidate-ios26.1-23b85-os-r123-1",
  );
  for (
    const [key, bad] of Object.entries({
      GITHUB_ACTIONS: "false",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REPOSITORY: "fork/web",
      GITHUB_REF: "refs/heads/feature",
      GITHUB_SHA: "main",
      GITHUB_RUN_ID: "1;echo bad",
      GITHUB_RUN_ATTEMPT: "0",
    })
  ) {
    assert.throws(() => producer({ ...env, [key]: bad }));
  }
  await assert.rejects(publishActions({}), /Explicit publication/);
});
test("portable search baseline is hash-pinned and retains every comparison field", async () => {
  const path = new URL(
    "../scripts/fixtures/ios261-os-search-baseline.json",
    import.meta.url,
  );
  assert.equal(await fileHash(path), pilot.baselineSha256);
  const baseline = JSON.parse(await readFile(path));
  assert.equal(baseline.packageManifest, pilot.packageManifest);
  assert.equal(baseline.languageProfiles.length, 432);
  assert.equal(
    compareRestoreSearch(baseline, { ...baseline, profilesWithSample: 432 })
      .cases,
    10,
  );
  const changed = structuredClone(baseline);
  changed.measurements[0].idsSha256 = "b".repeat(64);
  assert.throws(() => compareRestoreSearch(baseline, changed));
});

async function fixture() {
  const input = await mkdtemp(join(tmpdir(), "durable-distribution-"));
  const p = producer(env), image = "sha256:" + "c".repeat(64);
  const put = (name, data) =>
    writeFile(join(input, name), JSON.stringify(data));
  await writeFile(
    join(input, "import.sql.gz"),
    "inert fixture, never executed",
  );
  await writeFile(join(input, "image.tar"), "inert fixture, never loaded");
  const sqlSha256 = await fileHash(join(input, "import.sql.gz"));
  const common = {
    packageManifest: pilot.packageManifest,
    schema: pilot.schema,
    database: pilot.database,
    sqlSha256,
  };
  await put("report.json", {
    ...common,
    status: "durable-occurrence-sql-prepared",
    storage: "logged",
  });
  const sqlReportSha256 = await fileHash(join(input, "report.json"));
  await put("verification.json", {
    ...common,
    storage: "logged",
    status: "durable-release-sql-verified-not-imported",
    sqlReportSha256,
    releaseManifestSha256: pilot.manifestSha256,
  });
  await put("build.json", {
    ...common,
    image,
    baseImage: pilot.baseImage,
    tag: `applelocalization-data-candidate:${distributionTag(p)}`,
  });
  await put("startup.json", {
    ...common,
    image,
    status: "durable-image-startup-verified",
    initialization: "image-first-start",
    cleanRestartVerified: true,
    containerStopped: true,
    sqlReportSha256,
    baselineSha256: pilot.baselineSha256,
  });
  await put("guards.json", {
    image,
    status: "durable-image-guards-verified",
    results: [
      "wrong-database",
      "incomplete-volume",
      "different-dataset",
      "corrupt-sql",
    ].map((name) => ({ name, rejectedBeforeServing: true })),
  });
  await put("db-roundtrip.json", {
    ...common,
    status: "database-full-roundtrip-verified",
    rows: 21460150,
    quarantinedFiles: 233,
    languages: 432,
  });
  const baseline = JSON.parse(
    await readFile(
      new URL(
        "../scripts/fixtures/ios261-os-search-baseline.json",
        import.meta.url,
      ),
    ),
  );
  const search = { ...baseline, profilesWithSample: 432 };
  await put("db-search.json", search);
  await put("comparison.json", compareRestoreSearch(baseline, search));
  async function seal() {
    const files = {};
    for (const file of distributionFiles) {
      files[file] = {
        bytes: (await lstat(join(input, file))).size,
        sha256: await fileHash(join(input, file)),
      };
    }
    await put("distribution.json", {
      formatVersion: 1,
      status: "durable-distribution-verified-not-published",
      producer: p,
      pilot,
      tag: distributionTag(p),
      image,
      files,
      apiCompatible: false,
      productionReady: false,
    });
    return {
      input,
      sha256: await fileHash(join(input, "distribution.json")),
      expectedProducer: p,
    };
  }
  return { input, put, seal };
}
test("publication boundary rehashes all files and binds SQL, image and successful startup", async () => {
  const f = await fixture();
  let options = await f.seal();
  assert.equal((await verifyDistribution(options)).productionReady, false);
  await assert.rejects(
    verifyDistribution({
      ...options,
      expectedProducer: { ...options.expectedProducer, attempt: "2" },
    }),
  );
  await writeFile(join(f.input, "image.tar"), "corrupt");
  await assert.rejects(verifyDistribution(options));
  options = await f.seal();
  const startup = JSON.parse(await readFile(join(f.input, "startup.json")));
  await f.put("startup.json", { ...startup, cleanRestartVerified: false });
  options = await f.seal();
  await assert.rejects(verifyDistribution(options));
});
test("publication boundary refuses extras and symlinks even with otherwise valid manifest", async () => {
  const f = await fixture(), options = await f.seal();
  await writeFile(join(f.input, ".env"), "never publish");
  await assert.rejects(verifyDistribution(options), /allowlisted/);
  await unlink(join(f.input, ".env"));
  await unlink(join(f.input, "image.tar"));
  await symlink(join(f.input, "import.sql.gz"), join(f.input, "image.tar"));
  await assert.rejects(verifyDistribution(options), /symlinks/);
});
test("workflow keeps public credentials out of build and defaults to verification only", async () => {
  const workflow = await readFile(
    new URL(
      "../.github/workflows/localization-durable-candidate.yml",
      import.meta.url,
    ),
    "utf8",
  );
  const verifyJob = workflow.split("\n  publish:")[0];
  assert.ok(!verifyJob.includes("secrets."));
  assert.match(workflow, /default: false/);
  assert.match(workflow, /environment: localization-data-publication/);
  assert.match(workflow, /if: inputs.publish == true/);
  assert.match(
    workflow,
    /artifact-ids: \$\{\{ needs.verify.outputs.artifact_id \}\}/,
  );
  assert.ok(!workflow.includes("prune"));
});
