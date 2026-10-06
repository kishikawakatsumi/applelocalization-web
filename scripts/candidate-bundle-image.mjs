// Per-OS candidate image: exact artifact lineage, fresh-cluster restore, full row audit, then optional push.
import assert from "node:assert/strict";
import { bundleDatabase } from "./database-name.mjs";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  appendFile,
  copyFile,
  mkdir,
  readdir,
  readFile,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import {
  fileHash,
  sha256,
  treeHashes,
  writeJson,
} from "./collection-checkpoints.mjs";
import {
  batch,
  loadPlan,
  pipelineProducer,
  unpackCandidate,
  verifyCandidateSQL,
} from "./candidate-pipeline.mjs";
import {
  localDockerOnly,
  validateLoadReport,
} from "./load-occurrence-staging.mjs";
import { auditOccurrenceStaging } from "./audit-occurrence-staging.mjs";
import { psqlLines } from "./occurrence-staging.mjs";
import { structuredSearchMigration } from "./structured-search.mjs";
import { contextIndexMigration } from "./context-index-sql.mjs";
import {
  searchQueries,
  searchSettings,
  sqlText,
} from "./verify-occurrence-search.mjs";

export const baseImage =
  "groonga/pgroonga@sha256:841b25c58037c36d14f596c18b42e582d4d1672ae90484a440094ac7fa66e729";
export const imageRepository =
  "docker.io/kishikawakatsumi/applelocalization-data";
const execute = promisify(execFile),
  json = async (p) => JSON.parse(await readFile(p));
const run = async (program, args) =>
  (await execute(program, args, {
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 16 * 1024 ** 2,
  })).stdout.trim();
async function stream(program, args) {
  const child = spawn(program, args, { stdio: "inherit" });
  const code = await new Promise((ok, fail) => {
    child.on("error", fail);
    child.on("close", ok);
  });
  assert.equal(code, 0, `${program} failed`);
}
export function candidateTag(target, p) {
  assert.ok(
    batch.targets.some((t) =>
      t.id === target.id && t.version === target.version &&
      t.build === target.build
    ),
  );
  for (const field of ["runId", "attempt"]) {
    assert.match(p[field] ?? "", /^[1-9][0-9]{0,19}$/);
  }
  return `candidate-${target.id}-${target.version}-${target.build.toLowerCase()}-r${p.runId}-a${p.attempt}`;
}
export async function prepareBundleContext({ sql, bundle, output }) {
  const database = bundleDatabase(bundle);
  assert.deepEqual(await json(join(sql, "bundle.json")), bundle);
  const expected = batch.jobs.filter((c) => c.target === bundle.target.id);
  assert.deepEqual(
    bundle.components.map((c) => c.key),
    expected.map((c) => c.key),
  );
  await mkdir(output);
  const payload = join(output, "payload");
  await mkdir(payload);
  const files = [];
  for (const c of bundle.components) {
    assert.equal(c.schema, expected.find((x) => x.key === c.key).schema);
    assert.match(c.packageManifest, /^[a-f0-9]{64}$/);
    const reportBytes = await readFile(join(sql, c.key, "report.json")),
      report = JSON.parse(reportBytes),
      verification = await json(join(sql, c.key, "verification.json"));
    validateLoadReport(report, {
      durable: true,
      reportBytes,
      reportSha256: c.sqlReportSha256,
      verification,
    });
    assert.equal(report.schema, c.schema);
    assert.equal(report.database, database);
    assert.equal(report.packageManifest, c.packageManifest);
    assert.equal(
      await fileHash(join(sql, c.key, "import.sql.gz")),
      c.sqlSha256,
    );
    await mkdir(join(payload, c.key));
    const migration = `${c.key}/structured-search.sql`;
    await writeFile(
      join(payload, migration),
      structuredSearchMigration({
        database,
        components: [c],
      }),
      { flag: "wx" },
    );
    files.push(migration);
    const contextMigration = `${c.key}/context-index.sql`;
    await writeFile(
      join(payload, contextMigration),
      contextIndexMigration({
        database,
        components: [c],
      }),
      { flag: "wx" },
    );
    files.push(contextMigration);
    for (const file of ["import.sql.gz", "report.json", "verification.json"]) {
      const name = `${c.key}/${file}`;
      await copyFile(join(sql, name), join(payload, name));
      files.push(name);
    }
    assert.equal(
      await fileHash(join(payload, c.key, "import.sql.gz")),
      c.sqlSha256,
    );
    assert.equal(
      await fileHash(join(payload, c.key, "report.json")),
      c.sqlReportSha256,
    );
  }
  await copyFile(join(sql, "bundle.json"), join(payload, "bundle.json"));
  files.push("bundle.json");
  const identity = sha256(JSON.stringify(bundle));
  await writeFile(join(payload, "identity"), identity + "\n", { flag: "wx" });
  await writeFile(
    join(payload, "dataset.env"),
    `DATASET_DATABASE=${database}\n`,
    { flag: "wx" },
  );
  await writeFile(
    join(payload, "sources.tsv"),
    bundle.components.map((c) =>
      `${c.key}\t${c.schema}\t${c.packageManifest}\n`
    ).join(""),
    { flag: "wx" },
  );
  files.push("identity", "dataset.env", "sources.tsv");
  const hashes = [];
  for (const file of files) {
    hashes.push(`${await fileHash(join(payload, file))}  ${file}`);
  }
  await writeFile(join(payload, "SHA256SUMS"), hashes.join("\n") + "\n", {
    flag: "wx",
  });
  for (
    const file of [
      "Dockerfile",
      "initialize.sh",
      "healthcheck.sh",
      "postgres-init-entrypoint.sh",
    ]
  ) {
    await copyFile(
      fileURLToPath(
        new URL(`./templates/candidate-bundle/${file}`, import.meta.url),
      ),
      join(output, file),
    );
  }
  await copyFile(
    fileURLToPath(
      new URL(
        "./templates/candidate-bundle/localization-entrypoint.sh",
        import.meta.url,
      ),
    ),
    join(output, "localization-entrypoint.sh"),
  );
  return identity;
}
// Every language profile gets an exact-search exemplar where one exists. Fulltext probes use this source's text,
// not assumptions that every component contains the ten pilot strings or multiple Japanese translations of Open.
export async function verifyCandidateSearch({ component, lines }) {
  const s = component.schema, settings = searchSettings(s, true);
  const query = async (sql, extra = "") => {
    const out = [];
    for await (
      const line of lines(
        `BEGIN READ ONLY; SET LOCAL statement_timeout='120s'; ${settings} ${extra} SELECT coalesce(json_agg(q),'[]'::json) FROM (${sql}) q; COMMIT;`,
      )
    ) out.push(line);
    return JSON.parse(out.join("\n"));
  };
  const indexes = await query(
    `SELECT c.relname,i.indisvalid,i.indisready,pg_get_indexdef(i.indexrelid,1,true) AS first_column FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid JOIN pg_class t ON t.oid=i.indrelid JOIN pg_namespace n ON n.oid=t.relnamespace JOIN pg_am a ON a.oid=c.relam WHERE n.nspname=${
      sqlText(s)
    } AND t.relname='occurrence' AND a.amname='pgroonga'`,
  );
  // Historical images can still be audited before the additive migration.
  // The new API itself requires both text and JSON indexes at startup.
  assert.ok(indexes.length === 2 || indexes.length === 3);
  assert.ok(indexes.every((i) => i.indisvalid && i.indisready));
  const targetIndexes = indexes.filter((i) => i.first_column === "target_text");
  assert.equal(targetIndexes.length, 1);
  const jsonIndexes = indexes.filter((i) => i.first_column === "target_json");
  assert.equal(jsonIndexes.length, indexes.length - 2);
  const profiles = await query(
    `SELECT l.id,l.code,l.expected_rows::text,o.id::text AS sample_id FROM ${s}.language l LEFT JOIN LATERAL (SELECT id FROM ${s}.occurrence WHERE language_id=l.id AND target_text IS NOT NULL ORDER BY id LIMIT 1) o ON true ORDER BY l.id`,
  );
  const exact = [];
  for (const p of profiles) {
    if (p.sample_id === null) {
      exact.push({
        id: p.id,
        code: p.code,
        tested: false,
        reason: "no SQL-searchable text",
      });
      continue;
    }
    const [found] = await query(
      `SELECT EXISTS(SELECT 1 FROM ${s}.search_rows WHERE id=${
        Number(p.sample_id)
      } AND language=${
        sqlText(p.code)
      } AND target_text=(SELECT target_text FROM ${s}.occurrence WHERE id=${
        Number(p.sample_id)
      })) AS found`,
    );
    assert.equal(found.found, true);
    exact.push({ id: p.id, code: p.code, tested: true, sampleId: p.sample_id });
  }
  const probes = await query(
    `SELECT DISTINCT ON (l.code) l.id,l.code,o.target_text FROM ${s}.language l JOIN LATERAL (SELECT target_text FROM ${s}.occurrence WHERE language_id=l.id AND target_text IS NOT NULL AND length(target_text) BETWEEN 2 AND 40 ORDER BY id LIMIT 1) o ON true ORDER BY l.code,l.id LIMIT 10`,
  );
  const measurements = [];
  for (const p of probes) {
    const q = searchQueries(
      s,
      profiles.filter((x) => x.code === p.code).map((x) => x.id),
      p.target_text,
      targetIndexes[0].relname,
      true,
    );
    const indexed = await query(q.indexed, "SET LOCAL enable_seqscan=off;"),
      reference = await query(q.reference),
      page = await query(q.page),
      view = await query(q.view);
    assert.deepEqual(indexed, reference);
    assert.deepEqual(page, view);
    const explain = [];
    for await (
      const line of lines(
        `BEGIN READ ONLY; ${settings} SET LOCAL enable_seqscan=off; EXPLAIN (FORMAT JSON) ${q.indexed}; COMMIT;`,
      )
    ) explain.push(line);
    assert.ok(
      JSON.stringify(JSON.parse(explain.join("\n"))).includes(
        targetIndexes[0].relname,
      ),
      "Fulltext probe must use its PGroonga index",
    );
    measurements.push({
      language: p.code,
      term: p.target_text,
      result: indexed,
      pageSha256: sha256(JSON.stringify(page)),
    });
  }
  return {
    status: "candidate-search-verified",
    structuredSearchAvailable: jsonIndexes.length === 1,
    schema: s,
    packageManifest: component.packageManifest,
    profiles: exact,
    measurements,
    limitations: [
      "Source-derived probes, not a historical-content baseline or full Web/API test.",
      "Profiles with no SQL-searchable value are explicitly untested. Zero fulltext hits are recorded, not counted as positive retrieval tests.",
    ],
  };
}
async function rehearseBundle(
  { bundle, image, identity, releases, sql, output },
) {
  const database = bundleDatabase(bundle);
  await mkdir(output);
  localDockerOnly();
  const p = pipelineProducer(), nonce = randomBytes(16).toString("hex");
  const name =
      `applelocalization-bundle-${bundle.target.id}-${p.runId}-${p.attempt}`,
    volume = name + "-data";
  const docker = (...args) => run("docker", args);
  assert.ok(
    !(await docker("ps", "-a", "--format", "{{.Names}}")).split("\n").includes(
      name,
    ),
  );
  assert.ok(
    !(await docker("volume", "ls", "--format", "{{.Name}}")).split("\n")
      .includes(volume),
  );
  const inspect = async () => {
    const [c] = JSON.parse(await docker("inspect", name));
    assert.equal(c.Image, image);
    assert.equal(c.Config.Labels["org.applelocalization.nonce"], nonce);
    assert.equal(c.Config.Labels["org.applelocalization.bundle"], identity);
    assert.equal(c.HostConfig.NetworkMode, "none");
    assert.ok(
      c.Mounts.some((m) =>
        m.Type === "volume" && m.Name === volume &&
        m.Destination === "/var/lib/postgresql/data"
      ),
    );
    return c;
  };
  const capacity = async () => {
    const fs = await statfs(output);
    assert.ok(
      fs.bavail * fs.bsize > 10 * 1024 ** 3,
      "Runner disk reserve exhausted",
    );
  };
  const ready = async () => {
    for (let i = 0; i < 2700; i++) {
      await capacity();
      const c = await inspect();
      assert.equal(c.State.Running, true, "Candidate database exited");
      if (c.State.Health?.Status === "healthy") return;
      await delay(1000);
    }
    throw Error("Candidate initialization timeout");
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
      database,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = (sql) => psqlLines(sql, processSQL);
  let created = false;
  try {
    await docker(
      "volume",
      "create",
      "--label",
      `org.applelocalization.nonce=${nonce}`,
      volume,
    );
    const [v] = JSON.parse(await docker("volume", "inspect", volume));
    assert.equal(v.Labels["org.applelocalization.nonce"], nonce);
    created = true;
    await docker(
      "run",
      "-d",
      "--pull=never",
      "--platform=linux/amd64",
      "--name",
      name,
      "--network=none",
      "--restart=no",
      "--memory=4g",
      "--shm-size=256m",
      "--label",
      `org.applelocalization.nonce=${nonce}`,
      "--mount",
      `type=volume,source=${volume},target=/var/lib/postgresql/data`,
      "-e",
      `POSTGRES_DB=${database}`,
      "-e",
      `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}`,
      image,
    );
    await ready();
    const searches = [];
    for (const c of bundle.components) {
      await capacity();
      const audit = await auditOccurrenceStaging({
        input: join(releases, c.key, "package"),
        schema: c.schema,
        durable: true,
        query: lines,
        progress: (x) =>
          console.log(JSON.stringify({ component: c.key, audit: x })),
      });
      assert.equal(audit.status, "database-full-roundtrip-verified");
      await writeJson(join(output, `${c.key}-roundtrip.json`), audit);
      const search = await verifyCandidateSearch({ component: c, lines });
      searches.push(search);
      await writeJson(join(output, `${c.key}-search.json`), search);
    }
    await inspect();
    await docker("stop", "--time", "60", name);
    assert.equal((await inspect()).State.ExitCode, 0);
    await docker("start", name);
    await ready();
    for (let i = 0; i < bundle.components.length; i++) {
      assert.deepEqual(
        await verifyCandidateSearch({ component: bundle.components[i], lines }),
        searches[i],
      );
    }
    const logs = await docker("logs", name);
    assert.equal(
      logs.split("Localization bundle: initialization completed.").length - 1,
      1,
    );
    await docker("stop", "--time", "60", name);
    assert.equal((await inspect()).State.ExitCode, 0);
    const result = {
      status: "candidate-bundle-restore-verified",
      image,
      identity,
      components: bundle.components.map((c) => c.key),
      allRowsAndQuarantineCompared: true,
      cleanRestartVerified: true,
      containerStopped: true,
      apiCompatible: false,
      productionReady: false,
    };
    await writeJson(join(output, "result.json"), result);
    return result;
  } finally {
    if (created) {
      const c = await inspect();
      if (c.State.Running) await docker("stop", "--time", "60", name);
    }
  }
}
export async function buildCandidate(
  { plan: planPath, planSha256, target, input, sql, bundleSha256, output },
) {
  const producer = pipelineProducer();
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  localDockerOnly();
  output = resolve(output);
  await mkdir(output);
  const fs = await statfs(output);
  assert.ok(
    fs.bavail * fs.bsize >= 28 * 1024 ** 3,
    "Need 28 GiB free before candidate restore",
  );
  const { plan, selected } = await loadPlan(planPath, planSha256, target),
    releases = join(output, "releases");
  await unpackCandidate({ plan, selected, input, output: releases });
  const bundle = await verifyCandidateSQL({
    plan: planPath,
    planSha256,
    target,
    sql,
    bundleSha256,
    releases,
  });
  const tag = candidateTag(bundle.target, producer),
    localTag = `applelocalization-data-candidate:${tag}`;
  assert.ok(
    !(await run("docker", [
      "image",
      "ls",
      "--format",
      "{{.Repository}}:{{.Tag}}",
    ])).split("\n").includes(localTag),
  );
  await stream("docker", ["pull", "--platform=linux/amd64", baseImage]);
  const context = join(output, "context"),
    identity = await prepareBundleContext({ sql, bundle, output: context });
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
    `org.applelocalization.bundle=${identity}`,
    "--tag",
    localTag,
    context,
  ]);
  const [built] = JSON.parse(
    await run("docker", ["image", "inspect", localTag]),
  );
  assert.match(built.Id, /^sha256:[a-f0-9]{64}$/);
  const distribution = join(output, "distribution");
  await mkdir(distribution);
  await rehearseBundle({
    bundle,
    image: built.Id,
    identity,
    releases,
    sql,
    output: join(distribution, "verification"),
  });
  await stream("docker", [
    "save",
    "--output",
    join(distribution, "image.tar"),
    localTag,
  ]);
  await copyFile(join(sql, "bundle.json"), join(distribution, "bundle.json"));
  const files = await treeHashes(distribution);
  await writeJson(join(distribution, "distribution.json"), {
    formatVersion: 1,
    status: "candidate-bundle-image-verified",
    producer,
    target: bundle.target,
    source: bundle.source,
    tag,
    image: built.Id,
    baseImage,
    identity,
    bundleSha256,
    files,
    apiCompatible: false,
    productionReady: false,
    published: false,
  });
  if (process.env.GITHUB_OUTPUT) {
    await appendFile(
      process.env.GITHUB_OUTPUT,
      `distribution_sha256=${await fileHash(
        join(distribution, "distribution.json"),
      )}\n`,
    );
  }
}
export async function verifyCandidateDistribution({ input, sha256: expected }) {
  assert.match(expected ?? "", /^[a-f0-9]{64}$/);
  assert.equal(await fileHash(join(input, "distribution.json")), expected);
  const d = await json(join(input, "distribution.json")),
    producer = pipelineProducer();
  assert.equal(d.status, "candidate-bundle-image-verified");
  assert.equal(d.producer.runId, producer.runId);
  assert.equal(d.producer.commit, producer.commit);
  assert.ok(Number(d.producer.attempt) <= Number(producer.attempt));
  assert.equal(d.baseImage, baseImage);
  assert.equal(d.tag, candidateTag(d.target, d.producer));
  assert.match(d.image, /^sha256:[a-f0-9]{64}$/);
  assert.equal(d.apiCompatible, false);
  assert.equal(d.productionReady, false);
  assert.equal(d.published, false);
  const files = await treeHashes(input);
  delete files["distribution.json"];
  assert.deepEqual(files, d.files);
  assert.deepEqual((await readdir(input)).sort(), [
    "bundle.json",
    "distribution.json",
    "image.tar",
    "verification",
  ]);
  assert.equal(await fileHash(join(input, "bundle.json")), d.bundleSha256);
  const bundle = await json(join(input, "bundle.json"));
  assert.equal(sha256(JSON.stringify(bundle)), d.identity);
  assert.deepEqual(bundle.target, d.target);
  assert.deepEqual(bundle.source, d.source);
  const expectedComponents = batch.jobs.filter((c) => c.target === d.target.id);
  assert.deepEqual(
    bundle.components.map((c) => c.key),
    expectedComponents.map((c) => c.key),
  );
  assert.deepEqual(
    (await readdir(join(input, "verification"))).sort(),
    [
      "result.json",
      ...bundle.components.flatMap(
        (c) => [`${c.key}-roundtrip.json`, `${c.key}-search.json`],
      ),
    ].sort(),
  );
  const result = await json(join(input, "verification/result.json"));
  assert.equal(result.status, "candidate-bundle-restore-verified");
  assert.equal(result.image, d.image);
  assert.equal(result.identity, d.identity);
  assert.equal(result.allRowsAndQuarantineCompared, true);
  assert.equal(result.cleanRestartVerified, true);
  assert.equal(result.containerStopped, true);
  for (const c of bundle.components) {
    const audit = await json(
        join(input, `verification/${c.key}-roundtrip.json`),
      ),
      search = await json(join(input, `verification/${c.key}-search.json`));
    assert.equal(audit.status, "database-full-roundtrip-verified");
    assert.equal(audit.schema, c.schema);
    assert.equal(audit.packageManifest, c.packageManifest);
    assert.equal(
      c.schema,
      expectedComponents.find((x) => x.key === c.key).schema,
    );
    assert.equal(audit.rows, c.rows);
    assert.equal(audit.languages, c.languageProfiles);
    assert.equal(audit.quarantinedFiles, c.quarantinedFiles);
    assert.equal(search.status, "candidate-search-verified");
    assert.equal(search.packageManifest, c.packageManifest);
    assert.equal(search.schema, c.schema);
    assert.equal(search.profiles.length, c.languageProfiles);
  }
  return d;
}
export async function pushCandidate(
  { input, sha256, allowPush = false, output },
) {
  assert.equal(allowPush, true, "Explicit candidate push approval required");
  const d = await verifyCandidateDistribution({ input, sha256 });
  const response = await fetch(
    `https://hub.docker.com/v2/repositories/kishikawakatsumi/applelocalization-data/tags/${d.tag}/`,
    { signal: AbortSignal.timeout(30000) },
  );
  assert.equal(
    response.status,
    404,
    "Tag exists or absence cannot be confirmed; never overwrite",
  );
  await stream("docker", ["load", "--input", join(input, "image.tar")]);
  const [loaded] = JSON.parse(
    await run("docker", [
      "image",
      "inspect",
      `applelocalization-data-candidate:${d.tag}`,
    ]),
  );
  assert.equal(loaded.Id, d.image);
  assert.equal(
    loaded.Config.Labels["org.applelocalization.bundle"],
    d.identity,
  );
  const destination = `${imageRepository}:${d.tag}`;
  await run("docker", ["tag", d.image, destination]);
  await stream("docker", ["push", destination]);
  const [remote] = JSON.parse(
    await run("docker", ["image", "inspect", destination]),
  );
  const digest = remote.RepoDigests.find((x) =>
    x.startsWith("kishikawakatsumi/applelocalization-data@sha256:") ||
    x.startsWith(imageRepository + "@sha256:")
  );
  assert.ok(digest, "Missing pushed digest");
  await writeJson(output, {
    status: "candidate-image-pushed-not-deployed",
    image: destination,
    digest,
    producer: d.producer,
    target: d.target,
    source: d.source,
    distributionSha256: sha256,
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
        [
          "mode",
          "plan",
          "plan-sha256",
          "target",
          "input",
          "sql",
          "bundle-sha256",
          "output",
          "sha256",
        ].map((k) => [k, { type: "string" }]),
      ),
      "allow-push": { type: "boolean", default: false },
    },
  });
  if (v.mode === "build") {
    await buildCandidate({
      ...v,
      planSha256: v["plan-sha256"],
      bundleSha256: v["bundle-sha256"],
    });
  } else if (v.mode === "verify") await verifyCandidateDistribution(v);
  else {
    assert.equal(v.mode, "push");
    await pushCandidate({ ...v, allowPush: v["allow-push"] });
  }
}
