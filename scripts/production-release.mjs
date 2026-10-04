// Local Docker only. Prepares/starts a separate release; never switches public routing.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmod, copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { fileHash } from "./collection-checkpoints.mjs";
import { localDockerOnly } from "./load-occurrence-staging.mjs";
import { readOnlyRoleSQL } from "./database-role.mjs";
export { readOnlyRoleSQL } from "./database-role.mjs";
import {
  validateLocalContainer,
  validateLocalReceipt,
} from "./verify-release-set-local.mjs";

const repo = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const json = async (p) => JSON.parse(await readFile(p, "utf8"));
const save = (p, v) =>
  writeFile(p, JSON.stringify(v, null, 2) + "\n", { flag: "wx", mode: 0o600 });
const docker = (args, input) =>
  execFileSync("docker", args, {
    input,
    encoding: "utf8",
    timeout: 180000,
    maxBuffer: 8 * 1024 ** 2,
  }).trim();
const inspect = (name) => JSON.parse(docker(["inspect", name]))[0];
export function validateWebReceipt(r) {
  assert.equal(r.status, "release-web-image-pushed");
  assert.match(
    r.digest,
    /^kishikawakatsumi\/applelocalization-web@sha256:[a-f0-9]{64}$/,
  );
  assert.match(r.commit, /^[a-f0-9]{40}$/);
  assert.match(String(r.runId), /^[1-9][0-9]*$/);
  assert.match(String(r.attempt), /^[1-9][0-9]*$/);
  assert.equal(r.platform, "linux/amd64");
}
export function releasePort(port) {
  assert.match(String(port), /^[1-9][0-9]*$/);
  assert.ok(
    Number(port) >= 1024 && Number(port) <= 65535,
    "Use an unused nonprivileged loopback port",
  );
  return Number(port);
}
export function validateVerification(verified, owned, pushed) {
  assert.equal(
    verified.status,
    "unified-candidate-local-restore-verified-not-deployed",
  );
  for (
    const k of [
      "unifiedRestoreVerified",
      "countsAndSearchVerified",
      "cleanRestartVerified",
      "normalAutovacuumVerified",
    ]
  ) assert.equal(verified[k], true);
  for (const k of ["image", "name", "volume", "identity"]) {
    assert.equal(verified[k], owned[k]);
  }
  assert.equal(verified.image, pushed.imageId);
  assert.equal(verified.digest, pushed.digest);
  assert.equal(owned.digest, pushed.digest);
  assert.equal(owned.identity, pushed.identity);
  assert.equal(owned.receiptSha256, verified.receiptSha256);
}
function assertIdleVolume(owned) {
  const c = inspect(owned.name);
  validateLocalContainer(c, owned);
  assert.equal(c.State.Running, false, "Verifier container must be stopped");
  assert.equal(
    docker(["ps", "--filter", `volume=${owned.volume}`, "--format", "{{.ID}}"]),
    "",
    "Volume is in use; do not reuse the running review/production DB",
  );
  const v = JSON.parse(docker(["volume", "inspect", owned.volume]))[0];
  assert.equal(v.Labels["org.applelocalization.nonce"], owned.nonce);
  return c;
}
async function verifyFiles(root, state) {
  for (const [file, sha] of Object.entries(state.files)) {
    assert.equal(
      await fileHash(join(root, file)),
      sha,
      `Modified release file: ${file}`,
    );
  }
}
export function composeEnvironment(text, inherited = process.env) {
  const result = Object.fromEntries(
    Object.entries(inherited).filter(([key]) =>
      !key.startsWith("RELEASE_") && !key.startsWith("COMPOSE_")
    ),
  );
  for (const line of text.trim().split("\n")) {
    const match = /^(RELEASE_[A-Z_]+)=([A-Za-z0-9_/@:.\-]+)$/.exec(line);
    assert.ok(match, "Invalid prepared environment");
    assert.ok(!Object.hasOwn(result, match[1]), "Duplicate environment key");
    result[match[1]] = match[2];
  }
  return result;
}
export function contextIndexMode(value = "auto") {
  assert.ok(["auto", "off"].includes(value), "Invalid context index mode");
  return value;
}
async function prepare(v) {
  const contextMode = contextIndexMode(v["context-index-mode"]);
  assert.equal(
    v["allow-prepare"],
    true,
    "Explicit --allow-prepare required (creates a role in the verified DB)",
  );
  assert.match(v["web-receipt-sha256"] ?? "", /^[a-f0-9]{64}$/);
  const port = releasePort(v.port ?? 8085),
    input = resolve(v["verified-root"]),
    output = resolve(v.output);
  assert.equal(await fileHash(v["web-receipt"]), v["web-receipt-sha256"]);
  const web = await json(v["web-receipt"]);
  validateWebReceipt(web);
  const verified = await json(join(input, "validation/verified.json"));
  const owned = await json(join(input, "validation/ownership.json"));
  const pushed = await json(join(input, "receipts/pushed.json"));
  const assembly = await json(join(input, "receipts/assembled.json"));
  validateLocalReceipt(pushed, assembly);
  validateVerification(verified, owned, pushed);
  assert.equal(
    await fileHash(join(input, "receipts/pushed.json")),
    verified.receiptSha256,
  );
  assert.equal(
    await fileHash(join(input, "receipts/assembled.json")),
    pushed.assembledSha256,
  );
  localDockerOnly();
  const original = assertIdleVolume(owned);
  const admin = original.Config.Env.find((s) =>
    s.startsWith("POSTGRES_PASSWORD=")
  )?.slice(18);
  assert.ok(admin && !/[\r\n\0]/.test(admin), "Verifier password required");
  docker(["pull", "--platform", "linux/amd64", web.digest]);
  const image = JSON.parse(docker(["image", "inspect", web.digest]))[0];
  assert.equal(image.Os, "linux");
  assert.equal(image.Architecture, "amd64");
  assert.equal(
    image.Config.Labels["org.opencontainers.image.revision"],
    web.commit,
  );
  const db = JSON.parse(docker(["image", "inspect", pushed.digest]))[0];
  assert.equal(db.Id, pushed.imageId);
  await mkdir(output, { mode: 0o700 }); // New directory only; never overwrite a release.
  await mkdir(join(output, "metadata/bundles"), { recursive: true });
  // Metadata is mounted directly into a non-root container; host umask 077
  // must not make that mount unreadable. The outer release directory stays 0700.
  await chmod(join(output, "metadata"), 0o755);
  await chmod(join(output, "metadata/bundles"), 0o755);
  const files = {};
  const remember = async (file) => {
    files[file] = await fileHash(join(output, file));
  };
  await copyFile(
    join(repo, "deploy/compose.existing.yml"),
    join(output, "compose.yml"),
  );
  await remember("compose.yml");
  docker([
    "cp",
    owned.name + ":/opt/localization/release-set.json",
    join(output, "metadata/release-set.json"),
  ]);
  assert.equal(
    await fileHash(join(output, "metadata/release-set.json")),
    pushed.catalogSha256,
  );
  await remember("metadata/release-set.json");
  await chmod(join(output, "metadata/release-set.json"), 0o644);
  const catalog = await json(join(output, "metadata/release-set.json"));
  for (const pin of catalog.inputs) {
    assert.match(pin.target, /^(ios|macos)[0-9]+$/);
    const file = `metadata/bundles/${pin.target}.json`;
    docker([
      "cp",
      owned.name + ":/opt/localization/bundles/" + pin.target + ".json",
      join(output, file),
    ]);
    assert.equal(await fileHash(join(output, file)), pin.bundleSha256);
    await chmod(join(output, file), 0o644);
    await remember(file);
  }
  const nonce = randomBytes(12).toString("hex"),
    role = "web_" + nonce,
    password = randomBytes(32).toString("hex");
  // The parent is 0700. The app secret is readable by the non-root container user.
  await writeFile(join(output, "app-password"), password + "\n", {
    flag: "wx",
    mode: 0o644,
  });
  await chmod(join(output, "app-password"), 0o644);
  await writeFile(join(output, "admin-password"), admin + "\n", {
    flag: "wx",
    mode: 0o600,
  });
  const env = {
    RELEASE_DB_IMAGE: pushed.digest,
    RELEASE_WEB_IMAGE: web.digest,
    RELEASE_DB_VOLUME: owned.volume,
    RELEASE_DB_USER: role,
    RELEASE_CONTEXT_INDEX_MODE: contextMode,
    RELEASE_CATALOG_SHA256: pushed.catalogSha256,
    RELEASE_METADATA: join(output, "metadata"),
    RELEASE_APP_PASSWORD_FILE: join(output, "app-password"),
    RELEASE_ADMIN_PASSWORD_FILE: join(output, "admin-password"),
    RELEASE_PORT: String(port),
  };
  for (const value of Object.values(env)) {
    assert.match(
      value,
      /^[A-Za-z0-9_/@:.\-]+$/,
      "Use paths without spaces or shell metacharacters",
    );
  }
  await writeFile(
    join(output, "release.env"),
    Object.entries(env).map(([k, x]) => `${k}=${x}`).join("\n") + "\n",
    { flag: "wx", mode: 0o600 },
  );
  for (const file of ["release.env", "app-password", "admin-password"]) {
    await remember(file);
  }
  for (
    const [file, data] of Object.entries({
      "web-receipt.json": web,
      "db-receipt.json": pushed,
      "verification.json": verified,
      "ownership.json": owned,
    })
  ) {
    await save(join(output, file), data);
    await remember(file);
  }
  let started = false;
  try {
    assertIdleVolume(owned);
    docker(["start", owned.name]);
    started = true;
    let ready = false;
    for (let i = 0; i < 90; i++) {
      const c = inspect(owned.name);
      validateLocalContainer(c, owned);
      assert.ok(c.State.Running, "Verified DB exited");
      if (c.State.Health?.Status === "healthy") {
        ready = true;
        break;
      }
      await delay(2000);
    }
    assert.ok(ready, "DB healthcheck timed out");
    const schemas = catalog.datasets.flatMap((d) =>
      d.components.map((c) => c.schema)
    );
    docker([
      "exec",
      "-i",
      owned.name,
      "psql",
      "-X",
      "-v",
      "ON_ERROR_STOP=1",
      "-U",
      "postgres",
      "-d",
      "localization_staging",
    ], readOnlyRoleSQL(role, password, schemas));
  } finally {
    if (started) {
      validateLocalContainer(inspect(owned.name), owned);
      docker(["stop", "--time", "60", owned.name]);
    }
  }
  await save(join(output, "release.json"), {
    formatVersion: 1,
    status: "prepared-not-public",
    project: "localization-release-" + nonce,
    port,
    volume: owned.volume,
    webImageId: image.Id,
    dbImageId: db.Id,
    webDigest: web.digest,
    dbDigest: pushed.digest,
    catalogSha256: pushed.catalogSha256,
    files,
    preparedAt: new Date().toISOString(),
    publicRoutingChanged: false,
  });
  console.log(JSON.stringify({ status: "prepared-not-public", output, port }));
}
export async function smoke(base, catalog, fetcher = fetch) {
  const get = async (path) => {
    const r = await fetcher(base + path, {
      signal: AbortSignal.timeout(60000),
    });
    assert.equal(r.status, 200, path);
    return r;
  };
  const health = await (await get("/healthz")).json();
  assert.equal(health.ready, true);
  assert.equal(health.validationOnly, false);
  assert.equal(health.datasets, catalog.datasets.length);
  const results = [];
  for (const d of catalog.datasets) {
    const path = "/" + d.platform.toLowerCase() + "/" + d.version.split(".")[0];
    assert.match(await (await get(path)).text(), /<html/i);
    const c = await (await get("/api" + path + "/catalog")).json();
    assert.equal(c.target.id, d.id);
    assert.equal(c.target.version, d.version);
    assert.equal(c.target.build, d.build);
    const s = await (await get(
      "/api" + path + "/search?q=Open&l=English&l=Japanese&size=3",
    )).json();
    assert.equal(s.meta.dataset, d.id);
    assert.equal(s.meta.validationOnly, false);
    assert.ok(s.total > 0 && s.data.length > 0, `Empty search: ${d.id}`);
    const components = new Set(d.components.map((c) => c.key));
    for (const row of s.data) {
      assert.equal(row.dataset, d.id);
      assert.ok(components.has(row.component));
    }
    results.push({ dataset: d.id, total: s.total });
  }
  return results;
}
async function manage(command, v) {
  const root = resolve(v.output),
    state = await json(join(root, "release.json"));
  assert.equal(state.formatVersion, 1);
  assert.equal(state.status, "prepared-not-public");
  assert.match(state.project, /^localization-release-[a-f0-9]{24}$/);
  releasePort(state.port);
  await verifyFiles(root, state);
  localDockerOnly();
  const owned = await json(join(root, "ownership.json"));
  const original = inspect(owned.name);
  validateLocalContainer(original, owned);
  assert.equal(original.State.Running, false, "Verifier must remain stopped");
  for (
    const id of docker([
      "ps",
      "--filter",
      `volume=${owned.volume}`,
      "--format",
      "{{.ID}}",
    ]).split("\n").filter(Boolean)
  ) {
    assert.equal(
      inspect(id).Config.Labels["com.docker.compose.project"],
      state.project,
      "Another project uses this DB volume",
    );
  }
  const args = [
    "compose",
    "--project-name",
    state.project,
    "--env-file",
    join(root, "release.env"),
    "-f",
    join(root, "compose.yml"),
  ];
  // Shell variables have higher priority than --env-file. Do not let a stale
  // release variable silently select another image, port, secret or DB volume.
  const composeEnv = composeEnvironment(
    await readFile(join(root, "release.env"), "utf8"),
  );
  const compose = (tail) =>
    execFileSync("docker", [...args, ...tail], {
      encoding: "utf8",
      timeout: 300000,
      env: composeEnv,
    }).trim();
  if (command === "check") {
    const results = await smoke(
      `http://127.0.0.1:${state.port}`,
      await json(join(root, "metadata/release-set.json")),
    );
    const containers = compose(["ps", "-q"]).split("\n").filter(Boolean)
      .map(inspect);
    assert.equal(containers.length, 2);
    assert.deepEqual(
      containers.map((c) => c.Config.Labels["com.docker.compose.service"])
        .sort(),
      ["db", "web"],
    );
    for (const actual of containers) {
      assert.equal(actual.State.Health?.Status, "healthy");
      assert.equal(
        actual.Image,
        actual.Config.Labels["com.docker.compose.service"] === "web"
          ? state.webImageId
          : state.dbImageId,
      );
    }
    const receipt = {
      status: "local-smoke-passed-not-public",
      checkedAt: new Date().toISOString(),
      releaseSha256: await fileHash(join(root, "release.json")),
      results,
      publicRoutingChanged: false,
    };
    const file = "check-" + Date.now() + ".json";
    await save(join(root, file), receipt);
    console.log(
      JSON.stringify({ status: receipt.status, receipt: join(root, file) }),
    );
    return;
  }
  const tails = {
    up: ["up", "-d", "--no-build", "--wait", "--wait-timeout", "240"],
    stop: ["stop"],
    status: ["ps"],
    logs: ["logs", "--tail", "80"],
    config: ["config", "--quiet"],
  };
  assert.ok(Object.hasOwn(tails, command));
  execFileSync("docker", [...args, ...tails[command]], {
    stdio: "inherit",
    timeout: 300000,
    env: composeEnv,
  });
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { positionals, values: v } = parseArgs({
    allowPositionals: true,
    options: {
      ...Object.fromEntries(
        [
          "verified-root",
          "output",
          "web-receipt",
          "web-receipt-sha256",
          "port",
          "context-index-mode",
        ]
          .map((k) => [k, { type: "string" }]),
      ),
      "allow-prepare": { type: "boolean", default: false },
    },
  });
  assert.equal(positionals.length, 1);
  assert.ok(v.output);
  if (positionals[0] === "prepare") await prepare(v);
  else await manage(positionals[0], v);
}
