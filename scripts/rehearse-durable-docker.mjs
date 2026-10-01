// Local, isolated SQL restore rehearsal. No production settings, image push or existing volumes.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { mkdir, readFile, realpath, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { promisify } from "node:util";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { safeRead } from "./inspect-unlocalized-resources.mjs";
import { fileHash } from "./collection-checkpoints.mjs";
import {
  localDockerOnly,
  validateLoadReport,
} from "./load-occurrence-staging.mjs";
import { psqlLines, stagingDatabase } from "./occurrence-staging.mjs";
import {
  dfAvailableBytes,
  requireCapacity,
} from "./staging-capacity-guard.mjs";
import { auditOccurrenceStaging } from "./audit-occurrence-staging.mjs";
import { verifyOccurrenceSearch } from "./verify-occurrence-search.mjs";

const exec = promisify(execFile);
const purpose = "durable-sql-restore-rehearsal";
const labelKey = "org.applelocalization.rehearsal";
const nonceKey = "org.applelocalization.rehearsal-nonce";
const GiB = 1024 ** 3;

export function restoreIdentity(name, image) {
  assert.match(
    name ?? "",
    /^applelocalization-restore-[a-z0-9][a-z0-9-]{0,45}$/,
  );
  assert.match(
    image ?? "",
    /^sha256:[a-f0-9]{64}$/,
    "Use an already present immutable image ID",
  );
  return { name, volume: `${name}-data`, image };
}

export function assertOwnedRestoreContainer(container, identity, nonce) {
  assert.equal(container.Name, `/${identity.name}`);
  assert.equal(container.Image, identity.image);
  assert.equal(container.Config.Labels[labelKey], purpose);
  assert.equal(container.Config.Labels[nonceKey], nonce);
  assert.equal(container.HostConfig.NetworkMode, "none");
  assert.equal(container.Mounts.length, 1);
  assert.equal(container.Mounts[0].Type, "volume");
  assert.equal(container.Mounts[0].Name, identity.volume);
  assert.equal(container.Mounts[0].Destination, "/var/lib/postgresql/data");
}

export function compareRestoreSearch(baseline, restored) {
  assert.equal(baseline.status, "occurrence-search-verified");
  assert.equal(restored.status, "occurrence-search-verified");
  assert.equal(restored.packageManifest, baseline.packageManifest);
  assert.equal(restored.schema, baseline.schema);
  assert.equal(restored.conditionPolicy, baseline.conditionPolicy);
  assert.deepEqual(restored.languageProfiles, baseline.languageProfiles);
  assert.deepEqual(restored.variants, baseline.variants);
  assert.ok(baseline.measurements.length > 0);
  const comparable = (result) =>
    result.measurements.map((m) => {
      assert.equal(m.matchingIdsAgree, true);
      assert.equal(m.pagesAgree, true);
      return {
        language: m.language,
        term: m.term,
        matches: m.matches,
        idsSha256: m.idsSha256,
        pageRows: m.pageRows,
      };
    });
  assert.deepEqual(
    comparable(restored),
    comparable(baseline),
    "Restored search differs from the saved baseline",
  );
  return {
    status: "restore-search-matches-baseline",
    cases: baseline.measurements.length,
    profiles: restored.profilesWithSample,
    packageManifest: restored.packageManifest,
  };
}

export async function rehearseDurableDocker(
  {
    input,
    packageInput,
    baseline,
    output,
    name,
    image,
    reportSha256,
    baselineSha256,
    allowLocalRestoreWrite = false,
    imageStartup = false,
    progress = (x) => console.log(JSON.stringify(x)),
  },
) {
  assert.equal(
    allowLocalRestoreWrite,
    true,
    "Explicit local restore write approval required",
  );
  const identity = restoreIdentity(name, image);
  assert.match(baselineSha256 ?? "", /^[a-f0-9]{64}$/);
  localDockerOnly();
  input = await realpath(input);
  packageInput = await realpath(packageInput);
  output = join(await realpath(dirname(resolve(output))), basename(output));
  for (const source of [input, packageInput]) {
    assert.ok(
      output !== source && !output.startsWith(source + "/"),
      "Keep restore evidence outside source artifacts",
    );
  }
  const reportBytes = await safeRead(input, "report.json"),
    report = JSON.parse(reportBytes);
  const verification = JSON.parse(await safeRead(input, "verification.json"));
  validateLoadReport(report, {
    durable: true,
    reportSha256,
    reportBytes,
    verification,
  });
  assert.equal(await fileHash(join(input, "import.sql.gz")), report.sqlSha256);
  assert.equal(
    await fileHash(join(packageInput, "report.json")),
    report.packageManifest,
  );
  assert.equal(await fileHash(baseline), baselineSha256);
  const expectedSearch = JSON.parse(await readFile(baseline));
  assert.equal(expectedSearch.status, "occurrence-search-verified");
  assert.equal(expectedSearch.schema, report.schema);
  assert.equal(expectedSearch.packageManifest, report.packageManifest);
  const space = await statfs(input);
  assert.ok(
    space.bavail * space.bsize >= 22 * GiB,
    "Need 22 GiB free host space before an independent full restore",
  );
  const docker = async (...args) =>
    (await exec("docker", args, {
      encoding: "utf8",
      timeout: 120000,
      maxBuffer: 1024 * 1024,
    })).stdout.trim();
  const [cachedImage] = JSON.parse(await docker("image", "inspect", image));
  assert.equal(cachedImage.Id, image);
  const names =
    (await docker("container", "ls", "-a", "--format", "{{.Names}}")).split(
      "\n",
    );
  const volumes = (await docker("volume", "ls", "--format", "{{.Name}}")).split(
    "\n",
  );
  assert.ok(!names.includes(name), "Container already exists; never reuse it");
  assert.ok(
    !volumes.includes(identity.volume),
    "Volume already exists; never reuse it",
  );
  // mkdir is exclusive; do not mix attempts or overwrite prior evidence.
  await mkdir(output);
  const write = (file, value) =>
    writeFile(join(output, file), JSON.stringify(value, null, 2) + "\n", {
      flag: "wx",
    });
  const nonce = randomBytes(16).toString("hex");
  const receipt = {
    ...identity,
    database: stagingDatabase,
    schema: report.schema,
    packageManifest: report.packageManifest,
    sqlSha256: report.sqlSha256,
    sqlReportSha256: reportSha256,
    baselineSha256,
    published: false,
    initialization: imageStartup ? "image-first-start" : "external-sql-stream",
  };
  await write("plan.json", {
    ...receipt,
    nonce,
    status: "planned",
    imageTags: cachedImage.RepoTags,
  });
  let created = false, timer, capacityError, cancelling;
  let phase = imageStartup ? "image-initialization" : "import";
  const started = Date.now();
  const inspectOwned = async () => {
    const [container] = JSON.parse(await docker("inspect", name));
    assertOwnedRestoreContainer(container, identity, nonce);
    if (imageStartup) {
      assert.equal(
        container.Config.Labels["org.applelocalization.package"],
        report.packageManifest,
      );
      assert.equal(
        container.Config.Labels["org.applelocalization.sql"],
        report.sqlSha256,
      );
    }
    return container;
  };
  const stopOwned = async () => {
    const c = await inspectOwned();
    if (c.State.Running) await docker("stop", "--time", "60", name);
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
      stagingDatabase,
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = (sql) => psqlLines(sql, processSQL);
  const rows = async (sql) => {
    const out = [];
    for await (const row of lines(sql)) out.push(row);
    return out;
  };
  const ready = async () => {
    for (let attempt = 0; attempt < (imageStartup ? 1200 : 60); attempt++) {
      if (capacityError) throw capacityError;
      const c = await inspectOwned();
      assert.equal(c.State.Running, true, "Restore container exited");
      try {
        if (imageStartup && c.State.Health?.Status !== "healthy") {
          await delay(1000);
          continue;
        }
        assert.deepEqual(await rows("SELECT current_database()"), [
          stagingDatabase,
        ]);
        // Official entrypoint starts a temporary server before exec-ing postgres.
        const pid1 = await docker("exec", name, "cat", "/proc/1/comm");
        if (pid1 === "postgres") return;
      } catch { /* initdb is still running */ }
      await delay(1000);
    }
    throw new Error("Restore database did not become ready");
  };
  const capacity = () => {
    const dockerBytes = dfAvailableBytes(
      execFileSync("docker", [
        "exec",
        name,
        "df",
        "-Pk",
        "/var/lib/postgresql/data",
      ], { encoding: "utf8", timeout: 10000 }),
    );
    return statfs(input).then((s) =>
      requireCapacity({ hostBytes: s.bavail * s.bsize, dockerBytes }, 10 * GiB)
    );
  };
  const startMonitor = () => {
    timer = setInterval(() => {
      progress({
        phase,
        elapsedSeconds: Math.round((Date.now() - started) / 1000),
      });
      if (cancelling) return;
      Promise.resolve().then(capacity).catch((error) => {
        capacityError ??= error;
        cancelling = stopOwned();
        cancelling.catch(() => {});
      });
    }, 10000);
  };
  try {
    await docker(
      "volume",
      "create",
      "--label",
      `${labelKey}=${purpose}`,
      "--label",
      `${nonceKey}=${nonce}`,
      identity.volume,
    );
    const [volume] = JSON.parse(
      await docker("volume", "inspect", identity.volume),
    );
    assert.equal(
      volume.Labels[nonceKey],
      nonce,
      "Refuse a pre-existing volume",
    );
    // Even if docker run times out after starting the container, attempt an
    // ownership-checked stop. A concurrent unrelated container is never stopped.
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
      `${labelKey}=${purpose}`,
      "--label",
      `${nonceKey}=${nonce}`,
      "--mount",
      `type=volume,source=${identity.volume},target=/var/lib/postgresql/data`,
      "-e",
      `POSTGRES_DB=${stagingDatabase}`,
      "-e",
      `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}`,
      image,
    );
    if (imageStartup) {
      await inspectOwned();
      startMonitor();
      await ready();
      await capacity();
      await write("startup.json", {
        ...receipt,
        status: "image-initialization-healthy",
        freshVolume: true,
        externalSQLStream: false,
        containerId: (await inspectOwned()).Id,
      });
      await writeFile(
        join(output, "startup.log"),
        await docker("logs", "--tail", "150", name),
        { flag: "wx" },
      );
    } else {
      await ready();
      await capacity();
      // New cluster must be empty, including user tables in public. Then install the cached extension.
      const empty = await rows(
        "BEGIN READ ONLY; SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p','f') AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'; COMMIT;",
      );
      assert.deepEqual(empty, ["0"]);
      await rows("CREATE EXTENSION IF NOT EXISTS pgroonga;");
      await write("empty-cluster.json", {
        ...receipt,
        emptyUserTables: 0,
        containerId: (await inspectOwned()).Id,
      });
      startMonitor();
      const child = processSQL();
      let stderr = "";
      child.stderr.on("data", (bytes) => {
        stderr = (stderr + bytes).slice(-32000);
      });
      child.stdout.on(
        "data",
        (bytes) => progress({ phase, message: bytes.toString().trim() }),
      );
      const done = new Promise((res, rej) => {
        child.on("error", rej);
        child.on(
          "close",
          (code) =>
            code === 0 ? res() : rej(new Error(`psql exit ${code}: ${stderr}`)),
        );
      });
      done.catch(() => {});
      try {
        await pipeline(
          createReadStream(join(input, "import.sql.gz"), {
            flags: constants.O_RDONLY | constants.O_NOFOLLOW,
          }),
          createGunzip(),
          child.stdin,
        );
        await done;
      } finally {
        if (child.exitCode === null) child.kill();
        await done.catch(() => {});
      }
    }
    if (capacityError) throw capacityError;
    const persistence = await rows(
      `BEGIN READ ONLY; SELECT count(*),bool_and(c.relpersistence='p') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${report.schema}' AND c.relkind='r'; COMMIT;`,
    );
    assert.deepEqual(persistence, ["10|t"]);
    await write("import.json", {
      ...receipt,
      status: "restored-from-sql",
      loggedTables: 10,
      elapsedSeconds: (Date.now() - started) / 1000,
    });
    clearInterval(timer);
    timer = undefined;
    await stopOwned();
    assert.equal(
      (await inspectOwned()).State.ExitCode,
      0,
      "Postgres must stop cleanly",
    );
    await docker("start", name);
    await ready();
    if (imageStartup) {
      const log = await docker("logs", name);
      assert.equal(
        log.split("Localization image: dataset initialization completed.")
          .length - 1,
        1,
        "Restart must not rerun the SQL initializer",
      );
      await writeFile(join(output, "restart.log"), log, { flag: "wx" });
    }
    await write("restart.json", {
      ...receipt,
      status: "clean-restart-completed",
      crashRecoveryTest: false,
    });
    phase = "audit";
    const audit = await auditOccurrenceStaging({
      input: packageInput,
      schema: report.schema,
      durable: true,
      query: lines,
      progress: (p) => progress({ phase, ...p }),
    });
    await write("db-roundtrip.json", audit);
    phase = "search";
    const search = await verifyOccurrenceSearch({
      schema: report.schema,
      durable: true,
      verification: join(input, "verification.json"),
      lines,
      progress: (p) => progress({ phase, ...p }),
    });
    await write("db-search.json", search);
    const comparison = compareRestoreSearch(expectedSearch, search);
    await write("comparison.json", comparison);
    await stopOwned();
    const result = {
      ...receipt,
      status: imageStartup
        ? "durable-image-startup-verified"
        : "isolated-sql-restore-verified",
      rows: audit.rows,
      quarantinedFiles: audit.quarantinedFiles,
      profiles: comparison.profiles,
      fulltextCases: comparison.cases,
      cleanRestartVerified: true,
      crashRecoveryVerified: false,
      containerStopped: true,
      volumeRetained: true,
      productionReady: false,
      elapsedSeconds: (Date.now() - started) / 1000,
    };
    await write("result.json", result);
    return result;
  } catch (error) {
    if (timer) clearInterval(timer);
    if (cancelling) await cancelling.catch(() => {});
    let stopError;
    if (created) {
      await stopOwned().catch((e) => {
        stopError = String(e);
      });
    }
    await write("failure.json", {
      ...receipt,
      status: "failed-retained-for-inspection",
      error: String(error),
      stopError,
      capacityError: capacityError && String(capacityError),
    });
    throw error;
  } finally {
    if (timer) clearInterval(timer);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values: v } = parseArgs({
    options: {
      ...Object.fromEntries(
        [
          "input",
          "package-input",
          "baseline",
          "output",
          "name",
          "image",
          "report-sha256",
          "baseline-sha256",
        ].map((k) => [k, { type: "string" }]),
      ),
      "allow-local-restore-write": { type: "boolean", default: false },
      "image-startup": { type: "boolean", default: false },
    },
  });
  console.log(
    JSON.stringify(
      await rehearseDurableDocker({
        ...v,
        packageInput: v["package-input"],
        reportSha256: v["report-sha256"],
        baselineSha256: v["baseline-sha256"],
        allowLocalRestoreWrite: v["allow-local-restore-write"],
        imageStartup: v["image-startup"],
      }),
      null,
      2,
    ),
  );
}
