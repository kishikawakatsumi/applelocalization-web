// Local collection only. Completed outputs are immutable; failed attempts remain.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  rmdir,
  statfs,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export async function fileHash(path) {
  assert.ok((await lstat(path)).isFile(), `Not a regular file: ${path}`);
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(path)) digest.update(chunk);
  return digest.digest("hex");
}
// Include nested helpers in provenance and resume guards after directory changes.
export async function scriptCodeHashes(
  root = fileURLToPath(new URL("../", import.meta.url)),
) {
  const hashes = {};
  async function visit(directory) {
    for (const name of (await readdir(join(root, directory))).sort()) {
      if (name.startsWith(".")) continue;
      const relative = directory ? `${directory}/${name}` : name;
      const path = join(root, relative), stat = await lstat(path);
      if (stat.isDirectory()) await visit(relative);
      else if (/\.(mjs|py)$/.test(name)) hashes[relative] = await fileHash(path);
    }
  }
  await visit("");
  return hashes;
}
export async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
}
export async function checkSpace(path, minimumFreeBytes) {
  const fs = await statfs(path);
  assert.ok(
    fs.bavail * fs.bsize >= minimumFreeBytes,
    "Insufficient free space; existing artifacts were preserved",
  );
}
async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
export async function treeHashes(root) {
  const files = {};
  async function visit(relative) {
    const path = join(root, relative);
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      // Empty directories also belong to the seal.
      files[relative + "/"] = null;
      for (const name of (await readdir(path)).sort()) {
        await visit(relative ? relative + "/" + name : name);
      }
    } else {
      assert.ok(stat.isFile(), `Unsupported checkpoint entry: ${path}`);
      files[relative] = { bytes: stat.size, sha256: await fileHash(path) };
    }
  }
  await visit("");
  return files;
}

// Callers must hold this lock through source validation and mount cleanup too.
export async function withCollectionLock(output, action) {
  await mkdir(output, { recursive: true });
  assert.ok((await lstat(output)).isDirectory(), "Output cannot be a symlink");
  const lock = join(output, ".collection-lock");
  await mkdir(lock); // No automatic stale-lock stealing after crashes.
  try {
    return await action();
  } finally {
    await rmdir(lock);
  }
}

export async function runCheckpoints(
  {
    output,
    identity,
    stages,
    through,
    minimumFreeBytes = 10 * 1024 ** 3,
    progress = () => {},
  },
) {
  assert.ok(
    stages.length && new Set(stages.map((s) => s.name)).size === stages.length,
  );
  assert.ok(stages.every((s) => /^[a-z][a-z-]*$/.test(s.name)));
  through ??= stages.at(-1).name;
  assert.ok(stages.some((s) => s.name === through), "Unknown --through stage");
  const config = {
    formatVersion: 1,
    identity,
    stages: stages.map((s) => s.name),
  };
  const configPath = join(output, "collection.json");
  if (await exists(configPath)) {
    assert.deepEqual(
      JSON.parse(await readFile(configPath)),
      config,
      "Collection input or collector code changed; use a new output directory",
    );
  } else {
    assert.deepEqual(
      (await readdir(output)).filter((n) => n !== ".collection-lock"),
      [],
      "Refusing an unrelated nonempty output directory",
    );
    await writeJson(configPath, config);
  }
  const results = {};
  const dependencies = {};
  for (const stage of stages) {
    const receiptPath = join(output, stage.name + ".complete.json");
    if (await exists(receiptPath)) {
      const receipt = JSON.parse(await readFile(receiptPath));
      assert.equal(receipt.stage, stage.name);
      assert.deepEqual(
        receipt.dependencies,
        dependencies,
        "Upstream checkpoint changed",
      );
      assert.match(
        receipt.attempt,
        new RegExp(`^${stage.name}-attempt-[0-9]{4,}$`),
      );
      const attempt = join(output, receipt.attempt);
      assert.deepEqual(
        await treeHashes(attempt),
        receipt.files,
        `Completed stage changed: ${stage.name}`,
      );
      results[stage.name] = attempt;
      progress({ stage: stage.name, status: "verified-and-reused" });
    } else {
      await checkSpace(output, minimumFreeBytes);
      let attempt, attemptName;
      for (let index = 1;; index++) {
        attemptName = `${stage.name}-attempt-${String(index).padStart(4, "0")}`;
        attempt = join(output, attemptName);
        try {
          await mkdir(attempt);
          break;
        } catch (error) {
          if (error.code !== "EEXIST") throw error;
        }
      }
      progress({ stage: stage.name, status: "running", attempt: attemptName });
      await stage.run(attempt, results);
      await writeJson(receiptPath, {
        stage: stage.name,
        dependencies: { ...dependencies },
        attempt: attemptName,
        files: await treeHashes(attempt),
      });
      results[stage.name] = attempt;
      progress({ stage: stage.name, status: "completed" });
    }
    dependencies[stage.name] = await fileHash(receiptPath);
    if (stage.name === through) break;
  }
  return {
    status: through === stages.at(-1).name
      ? "collection-package-verified"
      : "collection-checkpoint-reached",
    through,
    outputs: results,
  };
}
