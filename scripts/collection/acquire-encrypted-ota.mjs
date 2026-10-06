// Pinned full OTA acquisition. Keys are temporary, never arguments/logs/artifacts.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { boundedCommand } from "./acquire-ipsw-component.mjs";
import { checkSpace, fileHash, writeJson } from "../shared/collection-checkpoints.mjs";
const execute = promisify(execFile);
const scripts = fileURLToPath(new URL("./", import.meta.url));

export function validateEncryptedOTA(s) {
  assert.equal(s.formatVersion, 1);
  assert.equal(s.kind, "ota-full-aea");
  assert.equal(s.os, "iOS");
  assert.match(s.version, /^\d+\.\d+(?:\.\d+)?$/);
  assert.match(s.build, /^\d+[A-Z]\d+[a-z]?$/);
  assert.match(s.device, /^iPhone\d+,\d+$/);
  const u = new URL(s.url);
  assert.equal(u.origin, "https://updates.cdn-apple.com");
  assert.ok(!u.username && !u.password && !u.search && !u.hash);
  assert.match(basename(u.pathname), /^[a-f0-9]{64}\.aea$/);
  assert.match(s.archiveSha256, /^[a-f0-9]{64}$/);
  for (const f of ["archiveBytes", "maximumDecryptedBytes"]) {
    assert.ok(Number.isSafeInteger(s[f]) && s[f] > 0 && s[f] <= 16 * 1024 ** 3);
  }
  if (s.decryptedSha256 !== undefined || s.decryptedBytes !== undefined) {
    assert.match(s.decryptedSha256 ?? "", /^[a-f0-9]{64}$/);
    assert.ok(
      Number.isSafeInteger(s.decryptedBytes) && s.decryptedBytes > 0 &&
        s.decryptedBytes <= s.maximumDecryptedBytes,
    );
  }
}

export function selectOTAKey(entries, spec) {
  // Assertions must never include a key value or the complete metadata object.
  assert.ok(Array.isArray(entries), "Invalid key metadata container");
  const matches = entries.filter((e) => e.url === spec.url);
  assert.ok(matches.length === 1, "Expected one key entry for pinned OTA URL");
  const e = matches[0];
  assert.ok(
    e.version === spec.version && e.build === spec.build,
    "Key release mismatch",
  );
  assert.ok(
    e.filename === basename(new URL(spec.url).pathname),
    "Key filename mismatch",
  );
  assert.ok(e.devices?.includes(spec.device), "Key device mismatch");
  assert.ok(
    typeof e.key === "string" && /^[A-Za-z0-9+/]{43}=$/.test(e.key),
    "Invalid symmetric key encoding",
  );
  const key = Buffer.from(e.key, "base64");
  assert.ok(
    key.length === 32 && key.toString("base64") === e.key,
    "Invalid symmetric key bytes",
  );
  return key;
}

export async function decryptOTAFile({ input, output, key, maximumBytes }) {
  await mkdir(output);
  const path = join(output, "decrypted-ota.bin");
  try {
    await boundedCommand("/usr/bin/aea", [
      "decrypt",
      "-i",
      input,
      "-o",
      path,
      "-key",
      key,
    ], { directory: output, maximumBytes });
  } catch {
    // Suppress subprocess diagnostics: key material may appear in upstream errors.
    throw new Error(
      "Native AEA decryption failed; subprocess output suppressed",
    );
  }
  const st = await lstat(path);
  assert.ok(st.isFile() && st.size > 0 && st.size <= maximumBytes);
  return { path, bytes: st.size, sha256: await fileHash(path) };
}

export async function acquireEncryptedOTA(
  { spec, output, tool, toolSha256, progress = console.log },
) {
  validateEncryptedOTA(spec);
  assert.equal(process.platform, "darwin");
  assert.equal(await fileHash(tool), toolSha256, "Pinned ipsw binary mismatch");
  await mkdir(output);
  await checkSpace(
    output,
    spec.archiveBytes + spec.maximumDecryptedBytes + 10 * 1024 ** 3,
  );
  const encrypted = join(output, "encrypted"), secret = join(output, "secrets");
  await mkdir(encrypted);
  await mkdir(secret, { mode: 0o700 });
  const archive = join(encrypted, basename(new URL(spec.url).pathname));
  const database = join(secret, "ota_fcs_keys.json"),
    keyPath = join(secret, "key.bin");
  let result;
  try {
    progress({ stage: "encrypted-ota-download", status: "running" });
    await boundedCommand("/usr/bin/curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--max-time",
      "1700",
      "--max-filesize",
      String(spec.archiveBytes),
      "--output",
      archive,
      spec.url,
    ], { directory: encrypted, maximumBytes: spec.archiveBytes });
    assert.equal((await lstat(archive)).size, spec.archiveBytes);
    assert.equal(await fileHash(archive), spec.archiveSha256);
    progress({ stage: "encrypted-ota-download", status: "completed" });
    try {
      await execute(tool, [
        "download",
        "ota",
        "--platform",
        "ios",
        "--version",
        spec.version,
        "--build",
        spec.build,
        "--device",
        spec.device,
        "--fcs-keys",
        "--output",
        secret,
        "--no-color",
      ], { timeout: 180000, maxBuffer: 4 * 1024 ** 2 });
    } catch {
      throw new Error("OTA key lookup failed; subprocess output suppressed");
    }
    assert.ok((await lstat(database)).isFile());
    await chmod(database, 0o600);
    assert.ok((await lstat(database)).size < 4 * 1024 ** 2);
    let entries;
    try {
      entries = JSON.parse(await readFile(database));
    } catch {
      throw new Error("Invalid key metadata JSON; contents suppressed");
    }
    const key = selectOTAKey(entries, spec);
    await writeFile(keyPath, key, { flag: "wx", mode: 0o600 });
    key.fill(0);
    progress({ stage: "encrypted-ota-decrypt", status: "running" });
    result = await decryptOTAFile({
      input: archive,
      output: join(output, "decrypted"),
      key: keyPath,
      maximumBytes: spec.maximumDecryptedBytes,
    });
    if (spec.decryptedSha256) {
      assert.equal(
        result.sha256,
        spec.decryptedSha256,
        "Decrypted OTA hash mismatch",
      );
      assert.equal(
        result.bytes,
        spec.decryptedBytes,
        "Decrypted OTA size mismatch",
      );
    }
    progress({
      stage: "encrypted-ota-decrypt",
      status: "completed",
      bytes: result.bytes,
      sha256: result.sha256,
    });
  } finally {
    for (const path of [database, keyPath]) {
      try {
        await unlink(path);
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }
  }
  // Discard only this invocation's verified temporary download, after successful decryption.
  await unlink(archive);
  await writeJson(join(output, "acquisition.json"), {
    status: "encrypted-ota-decrypted",
    spec,
    decrypted: result,
    secretsRetained: false,
  });
  return result;
}

async function inspectOnCI(output) {
  assert.equal(process.env.GITHUB_ACTIONS, "true");
  assert.equal(process.env.GITHUB_EVENT_NAME, "workflow_dispatch");
  assert.equal(process.env.GITHUB_REF, "refs/heads/main");
  assert.equal(
    process.env.GITHUB_REPOSITORY,
    "kishikawakatsumi/applelocalization-web",
  );
  const spec = JSON.parse(
    await readFile(join(scripts, "../plans/ios26-encrypted-ota.json")),
  );
  const { tool: pin } = JSON.parse(
    await readFile(join(scripts, "../plans/collection-batch-20261002.json")),
  );
  await mkdir(output);
  const toolDir = join(output, "tool");
  await mkdir(toolDir);
  const archive = join(toolDir, "ipsw.tar.gz");
  await boundedCommand("/usr/bin/curl", [
    "--fail",
    "--silent",
    "--show-error",
    "--location",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
    "--max-time",
    "240",
    "--max-filesize",
    String(pin.archiveBytes),
    "--output",
    archive,
    pin.url,
  ], { directory: toolDir, maximumBytes: pin.archiveBytes });
  assert.equal(await fileHash(archive), pin.archiveSha256);
  await execute("/usr/bin/tar", ["-xzf", archive, "-C", toolDir, "ipsw"]);
  const acquired = await acquireEncryptedOTA({
    spec,
    output: join(output, "acquired"),
    tool: join(toolDir, "ipsw"),
    toolSha256: pin.binarySha256,
  });
  const summary = await execute("python3", [
    "-B",
    join(scripts, "inspect-ota-layout.py"),
    "--archive",
    acquired.path,
    "--spec",
    join(scripts, "../plans/ios26-encrypted-ota.json"),
    "--summary",
  ], { timeout: 180000, maxBuffer: 1024 ** 2 });
  await writeJson(join(output, "diagnostics.json"), JSON.parse(summary.stdout));
  const normalized = await normalizeDecryptedOTA(
    acquired,
    join(output, "normalized"),
  );
  const { stdout } = await execute("python3", [
    "-B",
    join(scripts, "inspect-ota-layout.py"),
    "--archive",
    normalized.path,
    "--spec",
    join(scripts, "../plans/ios26-encrypted-ota.json"),
  ], { timeout: 120000, maxBuffer: 1024 ** 2 });
  const report = {
    ...JSON.parse(stdout),
    archiveSha256: spec.archiveSha256,
    decryptedSha256: acquired.sha256,
    decryptedBytes: acquired.bytes,
    normalizedSha256: normalized.sha256,
    normalizedBytes: normalized.bytes,
    sourceFormat: normalized.sourceFormat,
    metadataFixups: normalized.metadataFixups,
  };
  await writeJson(join(output, "layout.json"), report);
  console.log(JSON.stringify({ status: report.status, format: report.format }));
  assert.equal(report.status, "full-ota-layout-inspected");
}

export async function normalizeDecryptedOTA(acquired, output) {
  const { stdout } = await execute("python3", [
    "-B",
    join(scripts, "normalize-ota-archive.py"),
    "--archive",
    acquired.path,
    "--output",
    output,
  ], { timeout: 1800000, maxBuffer: 1024 ** 2 });
  const report = JSON.parse(stdout);
  assert.equal(report.status, "outer-ota-rewrapped");
  assert.equal(report.sourceSha256, acquired.sha256);
  assert.equal(report.path, join(output, "full-ota.zip"));
  await writeJson(join(output, "normalization.json"), report);
  // Remove only the verified decrypted temporary AA; original and derived hashes are retained.
  await unlink(acquired.path);
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      output: { type: "string" },
      "allow-download": { type: "boolean", default: false },
    },
  });
  assert.equal(values["allow-download"], true);
  assert.ok(values.output);
  await inspectOnCI(resolve(values.output));
}
