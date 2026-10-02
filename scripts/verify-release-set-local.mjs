// Explicitly authorized local-only restore of a digest-pinned assembled candidate.
// Retains its new, stopped container/volume. Never publishes, deploys or deletes data.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, statfs } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { fileHash, sha256, writeJson } from "./collection-checkpoints.mjs";
import { localDockerOnly } from "./load-occurrence-staging.mjs";
import { dfAvailableBytes } from "./staging-capacity-guard.mjs";
import { releaseCatalog } from "./compose-release-set.mjs";
import { verifyCandidateSearch } from "./candidate-bundle-image.mjs";
import { psqlLines } from "./occurrence-staging.mjs";
import {
  releaseTag,
  summarizeRestoreLogs,
  validateAssembled,
} from "./release-set-image.mjs";

const execute = promisify(execFile), GiB = 1024 ** 3;
const run = async (args) =>
  (await execute("docker", args, {
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 16 * 1024 ** 2,
  })).stdout.trim();
const json = async (path) => JSON.parse(await readFile(path));

export function validateLocalReceipt(pushed, assembled) {
  validateAssembled(assembled, assembled.producer);
  assert.equal(pushed.status, "unified-candidate-pushed-restore-pending");
  assert.deepEqual(pushed.producer, assembled.producer);
  assert.equal(
    pushed.image,
    `docker.io/kishikawakatsumi/applelocalization-data:${
      releaseTag(pushed.producer)
    }`,
  );
  assert.match(
    pushed.digest,
    /^(docker\.io\/)?kishikawakatsumi\/applelocalization-data@sha256:[a-f0-9]{64}$/,
  );
  assert.equal(pushed.imageId, assembled.image);
  assert.equal(pushed.identity, assembled.identity);
  assert.equal(pushed.catalogSha256, assembled.catalogSha256);
  assert.equal(pushed.unifiedRestoreVerified, false);
  assert.equal(pushed.productionDeployed, false);
  assert.equal(pushed.apiCompatible, false);
  assert.match(pushed.assembledSha256, /^[a-f0-9]{64}$/);
}
export function validateLocalContainer(
  c,
  { image, identity, nonce, name, volume },
) {
  assert.equal(c.Name, `/${name}`);
  assert.equal(c.Image, image);
  assert.equal(c.Config.Labels["org.applelocalization.nonce"], nonce);
  assert.equal(c.Config.Labels["org.applelocalization.bundle"], identity);
  assert.equal(c.HostConfig.NetworkMode, "none");
  assert.ok(
    !c.HostConfig.PortBindings ||
      Object.keys(c.HostConfig.PortBindings).length === 0,
  );
  assert.equal(
    c.Mounts.length,
    1,
    "No additional or existing mounts permitted",
  );
  assert.ok(
    c.Mounts.some((m) =>
      m.Type === "volume" && m.Name === volume &&
      m.Destination === "/var/lib/postgresql/data"
    ),
  );
}
export function requireLocalCapacity(hostBytes, dockerBytes, initial = false) {
  const minimum = (initial ? 200 : 10) * GiB;
  assert.ok(
    hostBytes >= minimum && dockerBytes >= minimum,
    `Need ${
      minimum / GiB
    } GiB free on BOTH the host and Docker data disk; expand the Docker VM disk if necessary`,
  );
}
export async function verifyLocalRelease(
  {
    receipt,
    receiptSha256,
    assembled,
    output,
    allowLocalRestore = false,
    allowPull = false,
  },
) {
  assert.equal(
    allowLocalRestore,
    true,
    "Explicit --allow-local-restore required",
  );
  assert.equal(allowPull, true, "Explicit --allow-pull required");
  assert.equal(
    process.env.GITHUB_ACTIONS,
    undefined,
    "Full-set restore is now a local task, not standard hosted CI",
  );
  assert.match(receiptSha256 ?? "", /^[a-f0-9]{64}$/);
  assert.equal(await fileHash(receipt), receiptSha256);
  const pushed = await json(receipt), assembly = await json(assembled);
  assert.equal(await fileHash(assembled), pushed.assembledSha256);
  validateLocalReceipt(pushed, assembly);
  localDockerOnly();
  const info = JSON.parse(await run(["info", "--format", "{{json .}}"]));
  assert.equal(info.OSType, "linux");
  assert.ok(
    info.MemTotal >= 6 * GiB,
    "Allocate at least 6 GiB of memory to Docker",
  );
  output = resolve(output);
  await mkdir(output); // Fresh directory only; never resume a partial restore implicitly.
  const hostSpace = async () => {
    const f = await statfs(output);
    return f.bavail * f.bsize;
  };
  assert.ok(
    await hostSpace() >= 200 * GiB,
    "Need at least 200 GiB host free space before pulling",
  );
  console.log(
    JSON.stringify({
      status: "pulling-digest-pinned-image",
      digest: pushed.digest,
      platform: "linux/amd64",
    }),
  );
  const pull = spawn("docker", [
    "pull",
    "--platform=linux/amd64",
    pushed.digest,
  ], { stdio: "inherit" });
  assert.equal(
    await new Promise((ok, fail) => {
      pull.on("error", fail);
      pull.on("close", ok);
    }),
    0,
  );
  const [image] = JSON.parse(await run(["image", "inspect", pushed.digest]));
  assert.equal(image.Id, pushed.imageId);
  assert.equal(
    image.Config.Labels["org.applelocalization.bundle"],
    pushed.identity,
  );
  assert.equal(image.Os, "linux");
  assert.equal(image.Architecture, "amd64");
  const imageCommand = (...command) =>
    run([
      "run",
      "--rm",
      "--network=none",
      "--pull=never",
      "--platform=linux/amd64",
      "--memory=256m",
      "--entrypoint",
      "/bin/sh",
      image.Id,
      ...command,
    ]);
  // An ephemeral metadata-only container never executes the database entrypoint.
  await imageCommand(
    "-c",
    "cd /opt/localization && sha256sum -c SHA256SUMS >/dev/null",
  );
  const catalogBytes = await imageCommand(
    "-c",
    "cat /opt/localization/release-set.json",
  );
  assert.equal(sha256(catalogBytes + "\n"), pushed.catalogSha256);
  const catalog = JSON.parse(catalogBytes);
  assert.deepEqual(catalog, assembly.catalog);
  assert.equal(sha256(JSON.stringify(catalog)), pushed.identity);
  const bundles = [];
  for (const dataset of catalog.datasets) {
    const bytes = await imageCommand(
      "-c",
      `cat /opt/localization/bundles/${dataset.id}.json`,
    );
    assert.equal(
      sha256(bytes + "\n"),
      catalog.inputs.find((p) => p.target === dataset.id).bundleSha256,
    );
    bundles.push(JSON.parse(bytes));
  }
  const { inputs: _pins, ...catalogWithoutPins } = catalog;
  assert.deepEqual(releaseCatalog(bundles), catalogWithoutPins);
  const dockerSpace = async () =>
    dfAvailableBytes(
      await imageCommand("-c", "df -Pk /var/lib/postgresql/data"),
    );
  requireLocalCapacity(await hostSpace(), await dockerSpace(), true);
  const nonce = randomBytes(16).toString("hex"),
    name = `localization-local-${pushed.producer.runId}-${nonce.slice(0, 12)}`,
    volume = `${name}-data`;
  assert.ok(
    !(await run(["ps", "-a", "--format", "{{.Names}}"])).split("\n").includes(
      name,
    ),
  );
  assert.ok(
    !(await run(["volume", "ls", "--format", "{{.Name}}"])).split("\n")
      .includes(volume),
  );
  const owned = {
    image: image.Id,
    identity: pushed.identity,
    nonce,
    name,
    volume,
  };
  await writeJson(join(output, "ownership.json"), {
    ...owned,
    digest: pushed.digest,
    receiptSha256,
    noPublishedPorts: true,
  });
  const inspect = async () => {
    const [c] = JSON.parse(await run(["inspect", name]));
    validateLocalContainer(c, owned);
    return c;
  };
  const capacitySamples = [];
  let created = false;
  const capacity = async () => {
    const hostBytes = await hostSpace();
    const dockerBytes = dfAvailableBytes(
      await run(["exec", name, "df", "-Pk", "/var/lib/postgresql/data"]),
    );
    capacitySamples.push({
      time: new Date().toISOString(),
      hostBytes,
      dockerBytes,
    });
    requireLocalCapacity(hostBytes, dockerBytes);
  };
  const ready = async () => {
    for (let i = 0; i < 2880; i++) {
      const c = await inspect();
      assert.equal(
        c.State.Running,
        true,
        "Local database exited during restore; see diagnostics.json",
      );
      await capacity();
      if (c.State.Health?.Status === "healthy") return;
      if (i % 6 === 0) {
        console.log(
          JSON.stringify({
            status: "local-unified-db-restoring",
            ...capacitySamples.at(-1),
          }),
        );
      }
      await delay(5000);
    }
    throw Error("Local restore exceeded four hours");
  };
  const sqlProcess = () =>
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
      "localization_staging",
      "-v",
      "ON_ERROR_STOP=1",
      "-At",
    ], { stdio: ["pipe", "pipe", "pipe"] });
  const lines = (sql) => psqlLines(sql, sqlProcess);
  const query = async (sql) => {
    const rows = [];
    for await (const line of lines(sql)) rows.push(line);
    return rows;
  };
  try {
    await run([
      "volume",
      "create",
      "--label",
      `org.applelocalization.nonce=${nonce}`,
      volume,
    ]);
    const [v] = JSON.parse(await run(["volume", "inspect", volume]));
    assert.equal(v.Labels["org.applelocalization.nonce"], nonce);
    await run([
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
      "--health-start-period=240m",
      "--health-timeout=60s",
      "--label",
      `org.applelocalization.nonce=${nonce}`,
      "--mount",
      `type=volume,source=${volume},target=/var/lib/postgresql/data`,
      "-e",
      "POSTGRES_DB=localization_staging",
      "-e",
      `POSTGRES_PASSWORD=${randomBytes(24).toString("hex")}`,
      image.Id,
    ]);
    created = true;
    await ready();
    assert.deepEqual(await query("SHOW autovacuum;"), ["on"]);
    const components = bundles.flatMap((b) => b.components), searches = [];
    assert.deepEqual(
      await query(
        "SELECT nspname FROM pg_namespace WHERE nspname LIKE 'localization_%' ORDER BY nspname;",
      ),
      components.map((c) => c.schema).sort(),
    );
    for (const c of components) {
      await capacity();
      assert.deepEqual(
        await query(
          `SELECT (SELECT count(*) FROM ${c.schema}.occurrence),(SELECT count(*) FROM ${c.schema}.language),(SELECT count(*) FROM ${c.schema}.quarantine);`,
        ),
        [`${c.rows}|${c.languageProfiles}|${c.quarantinedFiles}`],
      );
      const search = await verifyCandidateSearch({ component: c, lines });
      searches.push(search);
      await writeJson(join(output, `${c.key}-search.json`), search);
      console.log(
        JSON.stringify({
          component: c.key,
          status: "counts-and-search-verified",
        }),
      );
    }
    const [databaseBytes] = await query(
      "SELECT pg_database_size(current_database());",
    );
    await inspect();
    await run(["stop", "--time", "60", name]);
    assert.equal((await inspect()).State.ExitCode, 0);
    await run(["start", name]);
    await ready();
    assert.deepEqual(await query("SHOW autovacuum;"), ["on"]);
    for (const [i, c] of components.entries()) {
      await capacity();
      assert.deepEqual(
        await verifyCandidateSearch({ component: c, lines }),
        searches[i],
      );
    }
    assert.equal(
      (await run(["logs", name])).split(
        "Localization bundle: initialization completed.",
      ).length - 1,
      1,
    );
    await run(["stop", "--time", "60", name]);
    assert.equal((await inspect()).State.ExitCode, 0);
    await writeJson(join(output, "verified.json"), {
      status: "unified-candidate-local-restore-verified-not-deployed",
      digest: pushed.digest,
      image: image.Id,
      identity: pushed.identity,
      receiptSha256,
      name,
      volume,
      databaseBytes: Number(databaseBytes),
      targets: catalog.datasets.map((d) => d.id),
      components: components.length,
      countsAndSearchVerified: true,
      cleanRestartVerified: true,
      normalAutovacuumVerified: true,
      unifiedRestoreVerified: true,
      priorPerVersionFullAuditReused: true,
      allRowsReaudited: false,
      productionDeployed: false,
      apiCompatible: false,
      containerStopped: true,
    });
  } finally {
    await writeJson(join(output, "capacity.json"), capacitySamples);
    if (created) {
      const c = await inspect(); // Refuse to stop a replaced or foreign container.
      if (c.State.Running) await run(["stop", "--time", "60", name]);
      const state = (await inspect()).State;
      let logs;
      try {
        logs = await execute("docker", ["logs", "--tail", "200", name], {
          encoding: "utf8",
          timeout: 30000,
          maxBuffer: 1024 ** 2,
        });
      } catch (e) {
        logs = {
          stdout: e.stdout ?? "",
          stderr: e.stderr ?? "",
          captureIncomplete: true,
        };
      }
      await writeJson(join(output, "diagnostics.json"), {
        state: state.Status,
        exitCode: state.ExitCode,
        oomKilled: state.OOMKilled,
        logs: summarizeRestoreLogs(logs.stdout, logs.stderr),
        captureIncomplete: logs.captureIncomplete === true,
      });
    }
  }
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values: v } = parseArgs({
    options: {
      ...Object.fromEntries(
        ["receipt", "receipt-sha256", "assembled", "output"].map((
          k,
        ) => [k, { type: "string" }]),
      ),
      "allow-local-restore": { type: "boolean", default: false },
      "allow-pull": { type: "boolean", default: false },
    },
  });
  await verifyLocalRelease({
    ...v,
    receiptSha256: v["receipt-sha256"],
    allowLocalRestore: v["allow-local-restore"],
    allowPull: v["allow-pull"],
  });
}
