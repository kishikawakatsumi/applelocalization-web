import assert from "node:assert/strict";
import { validateReleaseDatabase } from "./database-name.mjs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { constants, createReadStream } from "node:fs";
import { lstat, realpath, statfs, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { safeRead } from "./inspect-unlocalized-resources.mjs";
import {
  occurrenceSQLLayout,
  psqlLines,
  psqlProcess,
  stagingContainer,
  stagingDatabase,
  validateSchema,
} from "./occurrence-staging.mjs";
import {
  dfAvailableBytes,
  requireCapacity,
  terminateStagingApplicationSQL,
} from "./staging-capacity-guard.mjs";

export function validateLoadReport(
  report,
  { durable = false, reportSha256, verification, reportBytes } = {},
) {
  if (!durable) {
    assert.equal(report.database, stagingDatabase);
    assert.equal(report.status, "staging-sql-prepared");
    assert.equal(report.container, stagingContainer);
    validateSchema(report.schema);
    return;
  }
  validateReleaseDatabase(report.database);
  assert.match(reportSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(
    createHash("sha256").update(reportBytes).digest("hex"),
    reportSha256,
    "Pinned SQL report mismatch",
  );
  assert.equal(report.status, "durable-occurrence-sql-prepared");
  assert.equal(report.storage, "logged");
  occurrenceSQLLayout({
    schema: report.schema,
    durable: true,
    database: report.database,
  });
  assert.equal(
    verification.status,
    "durable-release-sql-verified-not-imported",
  );
  assert.equal(verification.sqlReportSha256, reportSha256);
  for (
    const field of [
      "schema",
      "database",
      "storage",
      "sqlSha256",
      "packageManifest",
    ]
  ) {
    assert.equal(
      verification[field],
      report[field],
      `Verification mismatch: ${field}`,
    );
  }
}

export function localDockerOnly() {
  assert.ok(
    !process.env.DOCKER_HOST || process.env.DOCKER_HOST.startsWith("unix:///"),
    "Remote Docker is refused",
  );
  const endpoint = execFileSync("docker", [
    "context",
    "inspect",
    "--format",
    "{{.Endpoints.docker.Host}}",
  ], { encoding: "utf8" }).trim();
  assert.ok(
    endpoint.startsWith("unix:///"),
    "A local Unix Docker endpoint is required",
  );
}

export async function loadOccurrenceStaging(
  { input, allowLocalStagingWrite = false, durable = false, reportSha256 },
) {
  assert.equal(
    allowLocalStagingWrite,
    true,
    "Explicit local staging write approval is required",
  );
  localDockerOnly();
  const root = await realpath(input),
    reportBytes = await safeRead(root, "report.json"),
    report = JSON.parse(reportBytes);
  validateLoadReport(report, {
    durable,
    reportSha256,
    reportBytes,
    verification: durable
      ? JSON.parse(await safeRead(root, "verification.json"))
      : undefined,
  });
  // Unique connection tag permits cancelling only this import if capacity runs low.
  assert.equal(report.database, stagingDatabase);
  const previousApplication = process.env.LOCALIZATION_STAGING_APPLICATION_NAME;
  const application = `durable_import_${process.pid}_${Date.now()}`;
  async function capacity(minimum) {
    const space = await statfs(root);
    const dockerBytes = dfAvailableBytes(
      execFileSync("docker", [
        "exec",
        stagingContainer,
        "df",
        "-Pk",
        "/var/lib/postgresql/data",
      ], { encoding: "utf8", timeout: 10000 }),
    );
    requireCapacity(
      { hostBytes: space.bavail * space.bsize, dockerBytes },
      minimum,
    );
  }
  const resultFile = join(root, "load-result.json");
  // Reserve before writes; never accidentally repeat a successful import.
  await writeFile(
    resultFile,
    JSON.stringify({ status: "starting", schema: report.schema }) + "\n",
    { flag: "wx" },
  );
  await capacity(15 * 1024 ** 3);
  const path = join(root, "import.sql.gz");
  assert.ok(
    (await lstat(path)).isFile() && !(await lstat(path)).isSymbolicLink(),
  );
  const hash = createHash("sha256");
  for await (
    const bytes of createReadStream(path, {
      flags: constants.O_RDONLY | constants.O_NOFOLLOW,
    })
  ) hash.update(bytes);
  assert.equal(
    hash.digest("hex"),
    report.sqlSha256,
    "SQL artifact checksum mismatch",
  );
  const preflight = [];
  for await (
    const line of psqlLines(
      `BEGIN READ ONLY; SELECT current_database(); SELECT count(*) FROM pg_namespace WHERE nspname='${report.schema}'; SELECT extversion FROM pg_extension WHERE extname='pgroonga'; COMMIT;`,
    )
  ) preflight.push(line);
  assert.deepEqual(
    preflight.slice(0, 2),
    [stagingDatabase, "0"],
    "Database/schema preflight failed",
  );
  assert.ok(preflight[2], "PGroonga must already be installed");
  process.env.LOCALIZATION_STAGING_APPLICATION_NAME = application;
  const started = Date.now(), child = psqlProcess();
  if (previousApplication === undefined) {
    delete process.env.LOCALIZATION_STAGING_APPLICATION_NAME;
  } else {process.env.LOCALIZATION_STAGING_APPLICATION_NAME =
      previousApplication;}
  let guardError;
  async function stopImport(error) {
    guardError ??= error;
    try {
      for await (
        const _ of psqlLines(terminateStagingApplicationSQL(application))
      ) { /* drain */ }
    } finally {
      child.kill();
    }
  }
  let stderr = "";
  child.stderr.on("data", (bytes) => {
    stderr = (stderr + bytes).slice(-32000);
  });
  child.stdout.on("data", (bytes) => process.stdout.write(bytes));
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on(
      "close",
      (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`psql exited ${code}: ${stderr}`)),
    );
  });
  done.catch(() => {});
  let lastCheck = 0;
  const guard = new Transform({
    transform(chunk, encoding, callback) {
      if (Date.now() - lastCheck < 5000) {
        callback(null, chunk);
        return;
      }
      lastCheck = Date.now();
      statfs(root).then((space) => {
        assert.ok(
          space.bavail * space.bsize > 10 * 1024 ** 3,
          "Host free space below 10 GiB",
        );
        callback(null, chunk);
      }).catch(callback);
    },
  });
  const timer = setInterval(() => {
    console.log(
      JSON.stringify({
        importRunningSeconds: Math.round((Date.now() - started) / 1000),
      }),
    );
    capacity(10 * 1024 ** 3).catch((error) => stopImport(error)).catch(() =>
      child.kill()
    );
  }, 10000);
  try {
    await pipeline(
      createReadStream(path, {
        flags: constants.O_RDONLY | constants.O_NOFOLLOW,
      }),
      createGunzip(),
      guard,
      child.stdin,
    );
    await done;
    if (guardError) throw guardError;
    const result = {
      status: durable ? "loaded-durable-local-staging" : "loaded-local-staging",
      database: stagingDatabase,
      storage: durable ? "logged" : "unlogged",
      sqlSha256: report.sqlSha256,
      ...(durable ? { sqlReportSha256: reportSha256 } : {}),
      published: false,
      schema: report.schema,
      elapsedSeconds: (Date.now() - started) / 1000,
      packageManifest: report.packageManifest,
      stats: report.stats,
    };
    await writeFile(resultFile, JSON.stringify(result, null, 2) + "\n");
    return result;
  } catch (error) {
    await stopImport(error).catch(() => child.kill());
    await done.catch(() => {});
    await writeFile(
      resultFile,
      JSON.stringify(
        {
          status: "failed-check-transaction-state",
          schema: report.schema,
          error: String(error),
          stderr,
        },
        null,
        2,
      ) + "\n",
    );
    throw error;
  } finally {
    clearInterval(timer);
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      "allow-local-staging-write": { type: "boolean", default: false },
      durable: { type: "boolean", default: false },
      "report-sha256": { type: "string" },
    },
  });
  assert.ok(values.input);
  console.log(
    JSON.stringify(
      await loadOccurrenceStaging({
        input: values.input,
        allowLocalStagingWrite: values["allow-local-staging-write"],
        durable: values.durable,
        reportSha256: values["report-sha256"],
      }),
      null,
      2,
    ),
  );
}
