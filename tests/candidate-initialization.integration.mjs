// Opt-in, tiny Docker regression. No Apple data, network, ports or existing volumes.
// Keeps its stopped containers/volumes for diagnostics; never deletes existing data.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { createHash, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { baseImage } from "../scripts/candidate-bundle-image.mjs";

assert.equal(
  process.env.ALLOW_INITIALIZATION_TEST,
  "1",
  "Explicit opt-in required",
);
const root = await mkdtemp(join(tmpdir(), "localization-init-test-"));
const nonce = randomBytes(6).toString("hex");
const docker = (args, input) =>
  execFileSync("docker", args, {
    input,
    encoding: "utf8",
    timeout: 120000,
    maxBuffer: 4 * 1024 ** 2,
    stdio: ["pipe", "pipe", "pipe"],
  });
const base = process.env.INITIALIZATION_BASE_IMAGE ?? baseImage;
assert.match(
  base,
  /^(sha256:[a-f0-9]{64}|groonga\/pgroonga@sha256:[a-f0-9]{64})$/,
);
const template = new URL(
  "../scripts/templates/candidate-bundle/",
  import.meta.url,
);
const results = [];
for (const broken of [false, true]) {
  const kind = broken ? "failure" : "success";
  const context = join(root, kind), payload = join(context, "payload");
  await mkdir(payload, { recursive: true });
  for (
    const file of [
      "Dockerfile",
      "initialize.sh",
      "healthcheck.sh",
      "postgres-init-entrypoint.sh",
    ]
  ) {
    await copyFile(new URL(file, template), join(context, file));
  }
  await copyFile(
    new URL(
      "../scripts/templates/durable-image/localization-entrypoint.sh",
      import.meta.url,
    ),
    join(context, "localization-entrypoint.sh"),
  );
  const contents = {
    "identity": `${nonce}-${kind}\n`,
    "dataset.env": "DATASET_DATABASE=localization_staging\n",
    "sources.tsv":
      "first\tlocalization_first\tfixture\nsecond\tlocalization_second\tfixture\n",
  };
  for (const c of ["first", "second"]) {
    const schema = `localization_${c}`;
    await mkdir(join(payload, c));
    contents[`${c}/import.sql.gz`] = gzipSync(`BEGIN;
      CREATE SCHEMA ${schema}; SET search_path=${schema},public;
      CREATE TABLE package(id int, manifest_sha256 text); INSERT INTO package VALUES(1,'fixture');
      CREATE TABLE occurrence(body text); INSERT INTO occurrence SELECT 'hello '||i FROM generate_series(1,2000) i;
      ${
      Array.from(
        { length: 8 },
        (_, i) => `CREATE TABLE auxiliary_${i}(id int);`,
      ).join("\n")
    }
      CREATE INDEX body_idx ON occurrence USING pgroonga(body);
      DO $$ BEGIN ASSERT current_setting('autovacuum') = 'off'; END $$;
      ${c === "second" ? "SELECT pg_sleep(3);" : ""}
      ANALYZE occurrence;
      ${
      broken && c === "second" ? "SELECT nonexistent_fixture_function();" : ""
    }
      COMMIT;`);
  }
  const hashes = [];
  for (const [file, bytes] of Object.entries(contents)) {
    await writeFile(join(payload, file), bytes);
    hashes.push(`${createHash("sha256").update(bytes).digest("hex")}  ${file}`);
  }
  await writeFile(join(payload, "SHA256SUMS"), hashes.join("\n") + "\n");
  const tag = `applelocalization-data-candidate:init-test-${nonce}-${kind}`;
  docker([
    "build",
    "--platform=linux/amd64",
    "--network=none",
    "--build-arg",
    `BASE_IMAGE=${base}`,
    "-t",
    tag,
    context,
  ]);
  const name = `localization-init-test-${nonce}-${kind}`,
    volume = `${name}-data`;
  docker([
    "run",
    "-d",
    "--pull=never",
    "--name",
    name,
    "--network=none",
    "--platform=linux/amd64",
    "--memory=1g",
    "--mount",
    `type=volume,source=${volume},target=/var/lib/postgresql/data`,
    "-e",
    "POSTGRES_PASSWORD=isolated-fixture-only",
    tag,
    "postgres",
    "-c",
    "autovacuum_naptime=1s",
  ]);
  const inspect = () => JSON.parse(docker(["inspect", name]))[0];
  const sql = (text) =>
    docker([
      "exec",
      "-i",
      name,
      "psql",
      "-X",
      "-U",
      "postgres",
      "-d",
      "localization_staging",
      "-At",
      "-v",
      "ON_ERROR_STOP=1",
    ], text).trim();
  try {
    let finished = false;
    for (let i = 0; i < 90; i++) {
      const state = inspect().State;
      if (broken && !state.Running) {
        finished = true;
        break;
      }
      if (!broken) {
        assert.equal(state.Running, true);
        try {
          docker(["exec", name, "/usr/local/bin/localization-healthcheck.sh"]);
          finished = true;
          break;
        } catch {}
      }
      await delay(1000);
    }
    assert.ok(finished, "Initialization timed out");
    if (broken) {
      assert.notEqual(inspect().State.ExitCode, 0);
      docker(["start", name]);
      for (let i = 0; i < 20 && inspect().State.Running; i++) await delay(500);
      assert.equal(
        inspect().State.ExitCode,
        65,
        "Partial restore must be refused on restart",
      );
    } else {
      assert.equal(sql("SHOW autovacuum;"), "on");
      assert.equal(
        sql("SELECT count(*) FROM pg_file_settings WHERE name='autovacuum';"),
        "0",
      );
      assert.equal(
        sql(
          "VACUUM localization_first.occurrence; SET enable_seqscan=off; SELECT count(*) FROM localization_second.occurrence WHERE body &@ 'hello';",
        ),
        "VACUUM\nSET\n2000",
      );
      docker(["stop", name]);
      assert.equal(inspect().State.ExitCode, 0);
      docker(["start", name]);
      for (let i = 0; i < 30; i++) {
        try {
          docker(["exec", name, "/usr/local/bin/localization-healthcheck.sh"]);
          break;
        } catch {
          await delay(500);
        }
      }
      assert.equal(sql("SHOW autovacuum;"), "on");
      assert.equal(
        sql("SELECT count(*) FROM localization_second.occurrence;"),
        "2000",
      );
    }
    const logs = docker(["logs", name]);
    assert.equal(
      logs.split("Localization bundle: temporary-server autovacuum is off.")
        .length - 1,
      1,
    );
    assert.equal(
      logs.split("Localization bundle: initialization completed.").length - 1,
      broken ? 0 : 1,
    );
    results.push({ kind, passed: true, name, volume });
  } finally {
    if (inspect().State.Running) docker(["stop", name]);
  }
}
await writeFile(
  join(root, "results.json"),
  JSON.stringify(results, null, 2) + "\n",
);
console.log(JSON.stringify({ root, results }));
