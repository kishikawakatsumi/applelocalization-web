// Apple IPSW URL -> pinned local DMG/spec. No restore, device, or database writes.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, realpath } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  collectImage,
  selectManifestImage,
} from "./collect-image-localizations.mjs";
import {
  checkSpace,
  fileHash,
  runCheckpoints,
  sha256,
  withCollectionLock,
  writeJson,
} from "./collection-checkpoints.mjs";

const execute = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));
const reserve = 10 * 1024 ** 3;
// UniversalMac 26.1 has 147 identities and a 20,921,870-byte manifest.
// Keep a bounded limit, but do not assume the much smaller iPhone manifest size.
export const manifestLimit = 64 * 1024 ** 2;
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));

export function validateAcquisition(spec) {
  assert.equal(spec.formatVersion, 1);
  assert.ok(isAbsolute(spec.tool.path));
  assert.match(spec.tool.sha256, /^[a-f0-9]{64}$/);
  assert.match(spec.manifestSha256, /^[a-f0-9]{64}$/);
  for (const key of ["maximumDownloadBytes", "maximumImageBytes"]) {
    assert.ok(
      Number.isSafeInteger(spec[key]) && spec[key] > 0 &&
        spec[key] <= 100 * 1024 ** 3,
      `Invalid ${key}`,
    );
  }
  // Validate URL and selectors even before downloading the manifest.
  const pending = {
    ...spec,
    manifest: { path: "/BuildManifest.plist", sha256: spec.manifestSha256 },
  };
  selectManifestImage(pending, {
    sha256: spec.manifestSha256,
    version: spec.version,
    build: spec.build,
    products: [spec.product],
    identities: [{
      product: spec.product,
      board: spec.board,
      variant: spec.variant,
      images: { [spec.component]: spec.imagePath },
    }],
  });
}

export async function regularFiles(root) {
  const result = [];
  async function visit(path) {
    const stat = await lstat(path);
    if (stat.isDirectory()) {
      for (const name of (await readdir(path)).sort()) {
        await visit(join(path, name));
      }
    } else {
      assert.ok(stat.isFile(), `Nonregular acquisition output: ${path}`);
      result.push({ path, bytes: stat.size });
    }
  }
  await visit(root);
  return result;
}

export async function solePayload(directory, name, maximumBytes) {
  const files = await regularFiles(directory);
  assert.equal(
    files.length,
    1,
    "Extraction must produce exactly one regular file",
  );
  assert.equal(basename(files[0].path), name, "Unexpected extracted filename");
  assert.ok(
    files[0].bytes > 0 && files[0].bytes <= maximumBytes,
    "Extracted size exceeds budget or is empty",
  );
  return files[0];
}

// Budgets are conservative operator-supplied bounds, not exact ZIP metadata.
// Monitor both free space and bytes written; abort without deleting partial data.
export async function boundedCommand(
  command,
  args,
  { directory, maximumBytes, freeReserve = reserve, pollMs = 1000 },
) {
  await checkSpace(directory, freeReserve + maximumBytes);
  const controller = new AbortController();
  let failure, checking = Promise.resolve(), stopped = false;
  const check = async () => {
    if (stopped) return;
    await checkSpace(directory, freeReserve);
    const bytes = (await regularFiles(directory)).reduce(
      (sum, file) => sum + file.bytes,
      0,
    );
    assert.ok(
      bytes <= maximumBytes,
      "Acquisition output exceeded its byte budget",
    );
  };
  const timer = setInterval(() => {
    checking = checking.then(check).catch((error) => {
      failure ??= error;
      controller.abort();
    });
  }, pollMs);
  try {
    const result = await execute(command, args, {
      signal: controller.signal,
      timeout: 30 * 60 * 1000,
      maxBuffer: 8 * 1024 ** 2,
    });
    await checking;
    if (failure) throw failure;
    await check();
    return result;
  } catch (error) {
    throw failure ?? error;
  } finally {
    stopped = true;
    clearInterval(timer);
    await checking;
  }
}

export async function acquireComponent(
  { spec: specPath, output, through, progress = console.log },
) {
  const spec = await readJson(specPath);
  validateAcquisition(spec);
  output = resolve(output);
  return await withCollectionLock(output, async () => {
    assert.equal(
      await fileHash(spec.tool.path),
      spec.tool.sha256,
      "IPSW executable changed",
    );
    const toolVersion = (await execute(spec.tool.path, ["version"])).stdout
      .trim();
    const code = {};
    for (const name of (await readdir(scripts)).sort()) {
      if (/\.(mjs|py)$/.test(name)) {
        code[name] = await fileHash(join(scripts, name));
      }
    }
    const manifest = async (r) => {
      const path = (await solePayload(
        join(r.manifest, "payload"),
        "BuildManifest.plist",
        manifestLimit,
      )).path;
      const inventory = JSON.parse(
        (await execute("python3", [
          join(scripts, "inspect-ipsw-manifest.py"),
          path,
        ])).stdout,
      );
      const selection = {
        ...spec,
        manifest: { path, sha256: spec.manifestSha256 },
      };
      selectManifestImage(selection, inventory);
      return { path, inventory };
    };
    const stages = [
      {
        name: "manifest",
        run: async (out) => {
          // Reserve for the entire acquisition, not just this small first file.
          await checkSpace(
            output,
            reserve + manifestLimit + spec.maximumDownloadBytes +
              (spec.imagePath.endsWith(".aea") ? spec.maximumImageBytes : 0),
          );
          const directory = join(out, "payload");
          await mkdir(directory);
          await boundedCommand(spec.tool.path, [
            "extract",
            "--remote",
            spec.url,
            "--pattern",
            "^BuildManifest[.]plist$",
            "--output",
            directory,
            "--no-color",
          ], { directory, maximumBytes: manifestLimit });
          const result = await manifest({ manifest: out });
          await writeJson(join(out, "inventory.json"), result.inventory);
        },
      },
      {
        name: "download",
        run: async (out, r) => {
          await manifest(r);
          const directory = join(out, "payload");
          await mkdir(directory);
          const pattern = "^" +
            spec.imagePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "$";
          await boundedCommand(spec.tool.path, [
            "extract",
            "--remote",
            spec.url,
            "--pattern",
            pattern,
            "--output",
            directory,
            "--no-color",
          ], {
            directory,
            maximumBytes: spec.maximumDownloadBytes,
            freeReserve: reserve +
              (spec.imagePath.endsWith(".aea") ? spec.maximumImageBytes : 0),
          });
          const file = await solePayload(
            directory,
            spec.imagePath,
            spec.maximumDownloadBytes,
          );
          await writeJson(join(out, "file.json"), {
            ...file,
            sha256: await fileHash(file.path),
          });
        },
      },
      {
        name: "image",
        run: async (out, r) => {
          const downloaded = await readJson(join(r.download, "file.json"));
          let file;
          if (spec.imagePath.endsWith(".aea")) {
            const directory = join(out, "payload");
            await mkdir(directory);
            await boundedCommand(spec.tool.path, [
              "fw",
              "aea",
              downloaded.path,
              "--output",
              directory,
              "--no-color",
            ], { directory, maximumBytes: spec.maximumImageBytes });
            file = await solePayload(
              directory,
              spec.imagePath.slice(0, -4),
              spec.maximumImageBytes,
            );
          } else {
            // Plain DMG: keep one copy, record the exact downloaded file.
            file = await solePayload(
              join(r.download, "payload"),
              spec.imagePath,
              spec.maximumImageBytes,
            );
          }
          await writeJson(join(out, "file.json"), {
            ...file,
            path: await realpath(file.path),
            sha256: await fileHash(file.path),
          });
        },
      },
      {
        name: "prepared",
        run: async (out, r) => {
          const pinned = await manifest(r);
          const image = await readJson(join(r.image, "file.json"));
          const downloaded = await readJson(join(r.download, "file.json"));
          const {
            tool,
            manifestSha256,
            maximumDownloadBytes,
            maximumImageBytes,
            ...target
          } = spec;
          await writeJson(join(out, "collection-input.json"), {
            ...target,
            manifest: { path: pinned.path, sha256: manifestSha256 },
            image,
            downloadedImage: downloaded,
            acquisition: {
              tool,
              toolVersion,
              maximumDownloadBytes,
              maximumImageBytes,
            },
          });
        },
      },
    ];
    const result = await runCheckpoints({
      output,
      identity: { spec, toolVersion, codeSha256: sha256(JSON.stringify(code)) },
      stages,
      through,
      progress,
    });
    return {
      ...result,
      status: result.through === "prepared"
        ? "local-image-prepared-not-collected"
        : "acquisition-checkpoint-reached",
      collectionSpec: result.outputs.prepared
        ? join(result.outputs.prepared, "collection-input.json")
        : null,
    };
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      spec: { type: "string" },
      output: { type: "string" },
      through: { type: "string" },
      "collect-output": { type: "string" },
    },
  });
  assert.ok(values.spec && values.output, "--spec and --output required");
  assert.ok(
    !values["collect-output"] || !values.through,
    "Do not combine --through with --collect-output",
  );
  const progress = (value) => console.log(JSON.stringify(value));
  const result = await acquireComponent({ ...values, progress });
  console.log(JSON.stringify(result, null, 2));
  if (values["collect-output"]) {
    console.log(
      JSON.stringify(
        await collectImage({
          spec: result.collectionSpec,
          output: values["collect-output"],
          progress,
        }),
        null,
        2,
      ),
    );
  }
}
