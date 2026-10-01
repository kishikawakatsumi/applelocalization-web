// Pinned single-dataset pilot. No production deployment, mutable tags or PGDATA export.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs, promisify } from "node:util";
import { fileHash } from "./collection-checkpoints.mjs";
import { verifyReleaseAssets } from "./verify-release-assets.mjs";
import { prepareDurableReleaseSQL } from "./release-durable-sql.mjs";
import { buildDurableImage } from "./build-durable-image.mjs";
import { verifyImageGuards } from "./verify-durable-image-guards.mjs";
import {
  compareRestoreSearch,
  rehearseDurableDocker,
} from "./rehearse-durable-docker.mjs";
import { validateLoadReport } from "./load-occurrence-staging.mjs";
import { validateReleaseForPublication } from "./publish-intermediate-release.mjs";

export const pilot = Object.freeze({
  sourceRepository: "kishikawakatsumi/applelocalization-tools",
  sourceTag: "intermediate-ios26.1-23B85-os-quarantine-v2-r36882142781-1",
  artifactSha256:
    "05a3afd1096391b94ff8396e912ce79a707202ed788e3a1656f7daa0eb394e4d",
  manifestSha256:
    "73d486351756b74f8ff8a6f056f66630d8be214fcd5f4c8be61783acc3126ffd",
  packageManifest:
    "f8a7cc9771852617245dc7ade498e6ce3bcfb6ac89a4b26708eda931ecb21505",
  baselineSha256:
    "01e83b12681f8855470e44eef23b0b93be2471781494ecea39385d9a5c635a47",
  baseImage:
    "groonga/pgroonga@sha256:841b25c58037c36d14f596c18b42e582d4d1672ae90484a440094ac7fa66e729",
  schema: "localization_ios261_23b85_os_001",
  database: "localization_staging",
  repository: "kishikawakatsumi/applelocalization-data",
  imageRepository: "docker.io/kishikawakatsumi/applelocalization-data",
});
const baseline = fileURLToPath(
  new URL("./fixtures/ios261-os-search-baseline.json", import.meta.url),
);
const json = async (file) => JSON.parse(await readFile(file));
const write = (file, value) =>
  writeFile(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const exec = promisify(execFile);
const run = async (program, args) =>
  (await exec(program, args, {
    encoding: "utf8",
    timeout: 900000,
    maxBuffer: 8 * 1024 ** 2,
  })).stdout.trim();
async function stream(program, args) {
  const child = spawn(program, args, { stdio: "inherit" });
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", resolve);
  });
  assert.equal(code, 0, `${program} failed`);
}
export function producer(env = process.env) {
  assert.equal(
    env.GITHUB_ACTIONS,
    "true",
    "Only manual Actions runs may produce/publish",
  );
  assert.equal(env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(env.GITHUB_REPOSITORY, "kishikawakatsumi/applelocalization-web");
  assert.equal(env.GITHUB_REF, "refs/heads/main");
  assert.match(env.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  for (const key of ["GITHUB_RUN_ID", "GITHUB_RUN_ATTEMPT"]) {
    assert.match(env[key] ?? "", /^[1-9][0-9]{0,19}$/);
  }
  return {
    commit: env.GITHUB_SHA,
    runId: env.GITHUB_RUN_ID,
    attempt: env.GITHUB_RUN_ATTEMPT,
  };
}
export function distributionTag(p) {
  for (const value of [p.runId, p.attempt]) {
    assert.match(value ?? "", /^[1-9][0-9]{0,19}$/);
  }
  return `candidate-ios26.1-23b85-os-r${p.runId}-${p.attempt}`;
}
export const distributionFiles = Object.freeze([
  "import.sql.gz",
  "report.json",
  "verification.json",
  "image.tar",
  "build.json",
  "guards.json",
  "startup.json",
  "db-roundtrip.json",
  "db-search.json",
  "comparison.json",
]);

export async function prepareActions({ output }) {
  const p = producer();
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  const space = await statfs(resolve(output, ".."));
  console.log(JSON.stringify({
    stage: "capacity-preflight",
    availableGiB: Math.floor(space.bavail * space.bsize / 1024 ** 3),
    minimumGiB: 28,
  }));
  assert.ok(
    space.bavail * space.bsize >= 28 * 1024 ** 3,
    "Need 28 GiB free before download/build/restore; choose a larger Linux runner. No automatic disk cleanup.",
  );
  await mkdir(output);
  const assets = join(output, "assets"),
    release = join(output, "release"),
    sql = join(output, "sql");
  await mkdir(assets);
  console.log(JSON.stringify({ stage: "download", status: "running" }));
  await run("gh", [
    "release",
    "download",
    pilot.sourceTag,
    "--repo",
    pilot.sourceRepository,
    "--dir",
    assets,
    "--pattern",
    "artifact.json",
    "--pattern",
    "localization-intermediate.tar",
  ]);
  await verifyReleaseAssets({
    input: assets,
    output: release,
    artifactSha256: pilot.artifactSha256,
  });
  console.log(JSON.stringify({ stage: "intermediate-verification", status: "completed" }));
  await prepareDurableReleaseSQL({
    input: release,
    output: sql,
    manifestSha256: pilot.manifestSha256,
    schema: pilot.schema,
    database: pilot.database,
    progress: (counts) => console.log(JSON.stringify({ sql: counts })),
  });
  const reportSha256 = await fileHash(join(sql, "report.json"));
  console.log(JSON.stringify({ stage: "sql", status: "completed", reportSha256 }));
  await stream("docker", ["pull", "--platform=linux/amd64", pilot.baseImage]);
  const built = await buildDurableImage({
    input: sql,
    output: join(output, "image"),
    reportSha256,
    baseImage: pilot.baseImage,
    tag: `applelocalization-data-candidate:${distributionTag(p)}`,
    allowLocalImageBuild: true,
  });
  await verifyImageGuards({
    image: built.image,
    output: join(output, "guards.json"),
    allowLocalGuardTests: true,
  });
  await rehearseDurableDocker({
    input: sql,
    packageInput: join(release, "package"),
    baseline,
    output: join(output, "startup"),
    name: `applelocalization-restore-ci-${p.runId}-${p.attempt}`,
    image: built.image,
    reportSha256,
    baselineSha256: pilot.baselineSha256,
    imageStartup: true,
    allowLocalRestoreWrite: true,
  });
  const distribution = join(output, "distribution");
  console.log(JSON.stringify({ stage: "image-startup-verification", status: "completed" }));
  await mkdir(distribution);
  for (const file of ["import.sql.gz", "report.json", "verification.json"]) {
    await copyFile(join(sql, file), join(distribution, file));
  }
  await copyFile(
    join(output, "image/result.json"),
    join(distribution, "build.json"),
  );
  await copyFile(
    join(output, "guards.json"),
    join(distribution, "guards.json"),
  );
  await copyFile(
    join(output, "startup/result.json"),
    join(distribution, "startup.json"),
  );
  for (
    const file of ["db-roundtrip.json", "db-search.json", "comparison.json"]
  ) await copyFile(join(output, "startup", file), join(distribution, file));
  await stream("docker", [
    "image",
    "save",
    "--output",
    join(distribution, "image.tar"),
    built.tag,
  ]);
  const files = {};
  for (const file of distributionFiles) {
    files[file] = {
      bytes: (await lstat(join(distribution, file))).size,
      sha256: await fileHash(join(distribution, file)),
    };
  }
  const manifest = {
    formatVersion: 1,
    status: "durable-distribution-verified-not-published",
    producer: p,
    pilot,
    tag: distributionTag(p),
    image: built.image,
    files,
    apiCompatible: false,
    productionReady: false,
  };
  await write(join(distribution, "distribution.json"), manifest);
  const sha256 = await fileHash(join(distribution, "distribution.json"));
  await verifyDistribution({
    input: distribution,
    sha256,
    expectedProducer: p,
  });
  if (process.env.GITHUB_OUTPUT) {
    await writeFile(process.env.GITHUB_OUTPUT, `sha256=${sha256}\n`, {
      flag: "a",
    });
  }
  return { status: manifest.status, sha256, distribution };
}

export async function verifyDistribution({ input, sha256, expectedProducer }) {
  assert.match(sha256 ?? "", /^[a-f0-9]{64}$/);
  const names = [...distributionFiles, "distribution.json"].sort();
  assert.deepEqual(
    (await readdir(input)).sort(),
    names,
    "Only allowlisted artifacts may cross the publication boundary",
  );
  for (const file of names) {
    assert.ok(
      (await lstat(join(input, file))).isFile(),
      "No symlinks or directories",
    );
  }
  assert.equal(await fileHash(join(input, "distribution.json")), sha256);
  const manifest = await json(join(input, "distribution.json"));
  assert.equal(manifest.formatVersion, 1);
  assert.equal(manifest.status, "durable-distribution-verified-not-published");
  assert.deepEqual(manifest.producer, expectedProducer);
  assert.deepEqual(manifest.pilot, pilot);
  assert.equal(manifest.tag, distributionTag(expectedProducer));
  assert.equal(manifest.apiCompatible, false);
  assert.equal(manifest.productionReady, false);
  assert.match(manifest.image ?? "", /^sha256:[a-f0-9]{64}$/);
  assert.deepEqual(
    Object.keys(manifest.files).sort(),
    [...distributionFiles].sort(),
  );
  for (const file of distributionFiles) {
    assert.equal(
      (await lstat(join(input, file))).size,
      manifest.files[file].bytes,
    );
    assert.equal(
      await fileHash(join(input, file)),
      manifest.files[file].sha256,
      `${file} hash mismatch`,
    );
  }
  const report = await json(join(input, "report.json")),
    verification = await json(join(input, "verification.json"));
  validateLoadReport(report, {
    durable: true,
    reportBytes: await readFile(join(input, "report.json")),
    reportSha256: manifest.files["report.json"].sha256,
    verification,
  });
  assert.equal(report.status, "durable-occurrence-sql-prepared");
  assert.equal(report.storage, "logged");
  assert.equal(report.sqlSha256, manifest.files["import.sql.gz"].sha256);
  for (const r of [report, verification]) {
    assert.equal(r.packageManifest, pilot.packageManifest);
    assert.equal(r.schema, pilot.schema);
    assert.equal(r.database, pilot.database);
  }
  assert.equal(
    verification.status,
    "durable-release-sql-verified-not-imported",
  );
  assert.equal(
    verification.sqlReportSha256,
    manifest.files["report.json"].sha256,
  );
  assert.equal(verification.sqlSha256, report.sqlSha256);
  assert.equal(verification.releaseManifestSha256, pilot.manifestSha256);
  const build = await json(join(input, "build.json")),
    startup = await json(join(input, "startup.json"));
  assert.equal(build.baseImage, pilot.baseImage);
  assert.equal(build.tag, `applelocalization-data-candidate:${manifest.tag}`);
  for (const r of [build, startup]) {
    assert.equal(r.image, manifest.image);
    assert.equal(r.sqlSha256, report.sqlSha256);
    assert.equal(r.packageManifest, pilot.packageManifest);
  }
  assert.equal(startup.status, "durable-image-startup-verified");
  assert.equal(startup.initialization, "image-first-start");
  assert.equal(startup.cleanRestartVerified, true);
  assert.equal(startup.containerStopped, true);
  assert.equal(startup.sqlReportSha256, manifest.files["report.json"].sha256);
  assert.equal(startup.baselineSha256, pilot.baselineSha256);
  const guards = await json(join(input, "guards.json"));
  assert.equal(guards.status, "durable-image-guards-verified");
  assert.equal(guards.image, manifest.image);
  assert.deepEqual(guards.results.map((x) => x.name), [
    "wrong-database",
    "incomplete-volume",
    "different-dataset",
    "corrupt-sql",
  ]);
  assert.ok(guards.results.every((x) => x.rejectedBeforeServing === true));
  const audit = await json(join(input, "db-roundtrip.json"));
  assert.equal(audit.status, "database-full-roundtrip-verified");
  assert.equal(audit.schema, pilot.schema);
  assert.equal(audit.packageManifest, pilot.packageManifest);
  assert.equal(audit.rows, 21460150);
  assert.equal(audit.quarantinedFiles, 233);
  assert.equal(audit.languages, 432);
  assert.equal(await fileHash(baseline), pilot.baselineSha256);
  const comparison = compareRestoreSearch(
    await json(baseline),
    await json(join(input, "db-search.json")),
  );
  assert.deepEqual(await json(join(input, "comparison.json")), comparison);
  return manifest;
}

export async function publishActions(
  { input, sha256, allowPublicData = false, targetCommit },
) {
  assert.equal(allowPublicData, true, "Explicit publication approval required");
  const p = producer();
  assert.match(
    targetCommit ?? "",
    /^[a-f0-9]{40}$/,
    "Pin a commit in applelocalization-data, not the web repository",
  );
  const manifest = await verifyDistribution({
    input,
    sha256,
    expectedProducer: p,
  });
  const repository = pilot.repository,
    tag = manifest.tag,
    remoteImage = `${pilot.imageRepository}:${tag}`;
  // Only a definite 404 means absent. Authentication/network/rate-limit errors must stop publication.
  const response = await fetch(
    `https://hub.docker.com/v2/repositories/${repository}/tags/${tag}/`,
    { signal: AbortSignal.timeout(30000) },
  );
  assert.equal(
    response.status,
    404,
    "Docker tag exists or absence could not be established; never overwrite",
  );
  const commit = JSON.parse(
    await run("gh", ["api", `repos/${repository}/commits/${targetCommit}`]),
  );
  assert.equal(commit.sha, targetCommit);
  const refs = JSON.parse(
    await run("gh", [
      "api",
      `repos/${repository}/git/matching-refs/tags/${tag}`,
    ]),
  );
  assert.ok(
    !refs.some((x) => x.ref === `refs/tags/${tag}`),
    "Never reuse an existing Git tag",
  );
  await stream("docker", [
    "image",
    "load",
    "--input",
    join(input, "image.tar"),
  ]);
  const localTag = `applelocalization-data-candidate:${tag}`;
  const [loaded] = JSON.parse(
    await run("docker", ["image", "inspect", localTag]),
  );
  assert.equal(loaded.Id, manifest.image);
  assert.equal(
    loaded.Config.Labels["org.applelocalization.package"],
    pilot.packageManifest,
  );
  assert.equal(
    loaded.Config.Labels["org.applelocalization.sql"],
    manifest.files["import.sql.gz"].sha256,
  );
  // Save is transport-only. Release contains SQL and audit evidence, never PGDATA or image.tar.
  const releaseFiles = [
    "distribution.json",
    ...distributionFiles.filter((x) => x !== "image.tar"),
  ];
  const assets = await Promise.all(releaseFiles.map(async (name) => {
    const size = (await lstat(join(input, name))).size;
    assert.ok(size < 2 * 1024 ** 3, "Release assets must be below 2 GiB");
    return {
      name,
      size,
      digest: `sha256:${await fileHash(join(input, name))}`,
    };
  }));
  await run("gh", [
    "release",
    "create",
    tag,
    ...releaseFiles.map((x) => join(input, x)),
    "--repo",
    repository,
    "--target",
    targetCommit,
    "--draft",
    "--prerelease",
    "--latest=false",
    "--title",
    `iOS 26.1 OS durable candidate ${p.runId}/${p.attempt}`,
    "--notes",
    `Storage candidate only. Normal OS component only; not a complete OS or production web database.\nDatabase: localization_staging; API compatibility: false.\nSQL, quarantined originals and all collected language evidence are retained.\nProducer: https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${p.runId}\nCode commit: ${p.commit}\nDistribution manifest SHA-256: ${sha256}\nExpected image tag: ${remoteImage}\nimage.tar in distribution.json is Actions transport only and is not a Release asset.`,
  ]);
  const matches = JSON.parse(
    await run("gh", [
      "api",
      "--paginate",
      "--slurp",
      `repos/${repository}/releases?per_page=100`,
    ]),
  ).flat().filter((x) => x.tag_name === tag);
  assert.equal(matches.length, 1);
  const release = matches[0];
  assert.equal(release.draft, true);
  validateReleaseForPublication(release, { tag, commit: targetCommit, assets });
  await stream("docker", ["tag", localTag, remoteImage]);
  await stream("docker", ["push", remoteImage]);
  const [pushed] = JSON.parse(
    await run("docker", ["image", "inspect", remoteImage]),
  );
  const digests = pushed.RepoDigests.filter((x) =>
    x.startsWith(`${repository}@`) || x.startsWith(`${pilot.imageRepository}@`)
  ).map((x) => x.split("@")[1]);
  const raw = (await exec("docker", [
    "buildx",
    "imagetools",
    "inspect",
    "--raw",
    remoteImage,
  ], { encoding: "buffer", timeout: 120000 })).stdout;
  // buildx prints the raw manifest plus a newline. Docker's registry digest covers the manifest bytes only.
  const candidates = [raw, raw.at(-1) === 10 ? raw.subarray(0, -1) : raw];
  const digest = candidates.map((bytes) =>
    "sha256:" + createHash("sha256").update(bytes).digest("hex")
  ).find((x) => digests.includes(x));
  assert.ok(digest, "Remote manifest differs from pushed image");
  const published = JSON.parse(
    await run("gh", [
      "api",
      "--method",
      "PATCH",
      `repos/${repository}/releases/${release.id}`,
      "-F",
      "draft=false",
      "-F",
      "prerelease=true",
      "-f",
      "make_latest=false",
      "-f",
      `body=${release.body}\nVerified Docker digest: ${pilot.imageRepository}@${digest}`,
    ]),
  );
  validateReleaseForPublication(published, {
    tag,
    commit: targetCommit,
    assets,
  });
  assert.equal(published.draft, false);
  return {
    status: "durable-candidate-published",
    release: published.html_url,
    image: `${pilot.imageRepository}@${digest}`,
    productionReady: false,
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values: v } = parseArgs({
    options: {
      mode: { type: "string" },
      input: { type: "string" },
      output: { type: "string" },
      sha256: { type: "string" },
      "target-commit": { type: "string" },
      "allow-public-data": { type: "boolean", default: false },
    },
  });
  assert.ok(["prepare", "verify", "publish"].includes(v.mode));
  const result = v.mode === "prepare"
    ? await prepareActions(v)
    : v.mode === "verify"
    ? await verifyDistribution({ ...v, expectedProducer: producer() })
    : await publishActions({
      ...v,
      targetCommit: v["target-commit"],
      allowPublicData: v["allow-public-data"],
    });
  console.log(JSON.stringify(result, null, 2));
}
