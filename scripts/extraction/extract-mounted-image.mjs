// Offline diagnostic output only: no DB writes, language guessing or row deduplication.
import { createHash } from "node:crypto";
import process from "node:process";
import { constants, createWriteStream } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { createGzip } from "node:zlib";
import { once } from "node:events";
import { pipeline } from "node:stream/promises";
import { execFileSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  decodePlist,
  resourceParserPolicy,
  resourceRows,
} from "./extract-mounted-bundle.mjs";
import {
  assignBundle,
  bundlePolicies,
  currentBundlePolicy,
} from "../package/bundle-assignment.mjs";
import { readBundleMetadata } from "../package/bundle-metadata.mjs";

const formats = new Set([".strings", ".loctable", ".stringsdict"]);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const isInside = (root, path) => path === root || path.startsWith(root + "/");

class JsonLines {
  constructor(path) {
    this.stream = createGzip();
    this.done = pipeline(this.stream, createWriteStream(path, { flags: "wx" }));
    this.done.catch(() => {}); // Observed by close; prevent unhandled rejections while scanning.
    this.buffer = "";
    this.lines = 0;
  }
  async line(value) {
    this.buffer += JSON.stringify(value) + "\n";
    this.lines++;
    if (this.buffer.length >= 256 * 1024) await this.flush();
  }
  async flush() {
    if (this.stream.destroyed) {
      throw this.stream.errored ??
        new Error("Output stream closed unexpectedly");
    }
    if (!this.buffer) return;
    const text = this.buffer;
    this.buffer = "";
    if (!this.stream.write(text)) await once(this.stream, "drain");
  }
  async close() {
    await this.flush();
    this.stream.end();
    await this.done;
  }
}

export function resourceContext(imagePath, bundlePath, sourceId) {
  return {
    resourceId: hash(JSON.stringify([sourceId, imagePath])),
    sourceId,
    imagePath,
    bundlePath,
    resourcePath: bundlePath
      ? imagePath.slice(bundlePath.length + 1)
      : imagePath.slice(1),
    bundleName: bundlePath ? basename(bundlePath) : null,
    bundleAssignment: bundlePath
      ? "nearest-known-bundle-extension"
      : "unbundled",
  };
}

export async function extractMountedImage(
  {
    root,
    output,
    label,
    minimumFreeBytes = 10 * 1024 ** 3,
    requireReadOnlyMount = true,
    decode = decodePlist,
    progress = () => {},
    subtree = null,
    installerProjection = null,
    otaProjection = null,
    bundlePolicyVersion = currentBundlePolicy.version,
  },
) {
  const bundlePolicy = bundlePolicies[bundlePolicyVersion];
  if (!Number.isInteger(bundlePolicyVersion) || !bundlePolicy) {
    throw new Error("Unsupported bundle policy version");
  }
  if (!label) throw new Error("A unique image source label is required");
  if (installerProjection !== null && otaProjection !== null) {
    throw new Error("Ambiguous projection identity");
  }
  const ota = otaProjection !== null;
  installerProjection ??= otaProjection;
  // Describes already verified input, not an alternate mount verification path.
  // The installer runner must verify the projection before calling this API.
  let projectionScope = null;
  if (installerProjection !== null) {
    if (
      requireReadOnlyMount !== false || subtree !== null ||
      typeof installerProjection !== "object" ||
      !/^[0-9]+(?:\.[0-9]+)*$/.test(installerProjection.version ?? "") ||
      !/^[A-Za-z0-9]+$/.test(installerProjection.build ?? "") ||
      !["archiveSha256", "extractionReportSha256", "auditSha256"].every((key) =>
        /^[a-f0-9]{64}$/.test(installerProjection[key] ?? "")
      )
    ) throw new Error("Invalid installer projection identity or scan options");
    projectionScope = {
      kind: ota ? "ota-resource-projection" : "installer-resource-projection",
      version: installerProjection.version,
      build: installerProjection.build,
      archiveSha256: installerProjection.archiveSha256,
      extractionReportSha256: installerProjection.extractionReportSha256,
      auditSha256: installerProjection.auditSha256,
    };
  }
  const sourceRoot = await realpath(root);
  if (sourceRoot === "/") throw new Error("Refusing to scan the host root");
  if (requireReadOnlyMount) {
    const mounts = execFileSync("/sbin/mount", [], { encoding: "utf8" });
    const line = mounts.split("\n").find((line) =>
      line.includes(` on ${sourceRoot} (`)
    );
    if (
      !line ||
      !line.split(" (").at(-1).replace(/\)$/, "").split(", ").includes(
        "read-only",
      )
    ) {
      throw new Error("Input must be the root of a read-only mount");
    }
  }
  const sourceDevice = (await lstat(sourceRoot)).dev;
  let scopePath = sourceRoot, scopeImagePath = "";
  if (subtree !== null) {
    if (
      typeof subtree !== "string" || !subtree.split("/").every((p) =>
        p && p !== "." && p !== ".."
      ) || subtree.includes("\0")
    ) throw new Error("Invalid subtree path");
    for (const part of subtree.split("/")) {
      scopePath = join(scopePath, part);
      const stat = await lstat(scopePath);
      if (
        stat.isSymbolicLink() || !stat.isDirectory() ||
        stat.dev !== sourceDevice
      ) {
        throw new Error(
          "Subtree must use non-symlink directories on the input filesystem",
        );
      }
    }
    scopeImagePath = "/" + subtree;
  }
  const destination = resolve(output);
  const actualDestination = join(
    await realpath(dirname(destination)),
    basename(destination),
  );
  if (isInside(sourceRoot, actualDestination)) {
    throw new Error("Output must be outside the input image");
  }
  await mkdir(destination);
  await mkdir(join(destination, "quarantine"));
  const writers = Object.fromEntries(
    ["rows", "files", "issues", "symlinks"].map((
      name,
    ) => [name, new JsonLines(join(destination, name + ".jsonl.gz"))]),
  );
  const report = {
    formatVersion: 1,
    status: "running",
    startedAt: new Date().toISOString(),
    source: {
      sourceId: label,
      root: sourceRoot,
      readOnlyMountRequired: requireReadOnlyMount,
      scope: projectionScope ??
        (subtree === null
          ? { kind: "whole-image" }
          : { kind: "subtree", imagePath: scopeImagePath }),
    },
    bundlePolicy,
    resourceParserPolicy,
    counts: {
      directories: 0,
      files: 0,
      resourceFiles: 0,
      parsedFiles: 0,
      failedFiles: 0,
      emptyFiles: 0,
      unbundledFiles: 0,
      rows: 0,
      textRows: 0,
      structuredRows: 0,
      symlinks: 0,
      enumerationErrors: 0,
      crossDeviceDirectories: 0,
      quarantinedFiles: 0,
      decodeRetries: 0,
      bundleMetadataIssues: 0,
    },
    formats: {},
    topLevel: {},
    issueReasons: {},
    limitations: [
      projectionScope
        ? "Selected regular files from installer payloads only, not a complete OS image. Cryptexes, BaseSystem and omitted assets are outside scope. No symbolic links are followed."
        : "One image only, not all IPSW images. No symbolic links or other mounted filesystems are followed.",
      "Bundle assignment uses allowlisted extensions and Info.plist evidence; existing extensions retain an explicit fallback. Not CFBundle or code signature validation. Unknown extensions are not promoted.",
      "No language is guessed for files outside a single .lproj directory. Failed files with readable bytes are quarantined.",
      "Rows are occurrences, not unique translations. Equal values and differing translations both retain file/source context.",
      "The key is the resource key, not necessarily English source text. Text, structured values and empty values are preserved.",
      "Only .strings, .loctable and .stringsdict are decoded. Compiled UI files and other assets are outside parser scope.",
    ],
  };
  const bundles = new Set(), languages = new Set();
  let lastCheck = 0;
  async function checkSpace(force = false) {
    if (!force && Date.now() - lastCheck < 5000) return;
    const fs = await statfs(destination);
    if (fs.bavail * fs.bsize < minimumFreeBytes) {
      throw new Error("Free space fell below the reserved minimum; aborting");
    }
    lastCheck = Date.now();
    progress({ ...report.counts });
  }
  async function issue(path, stage, error) {
    const reason = `${stage}: ${error.code ?? error.message}`;
    report.issueReasons[reason] = (report.issueReasons[reason] ?? 0) + 1;
    await writers.issues.line({
      imagePath: path,
      stage,
      code: error.code ?? null,
      message: error.message,
    });
  }
  async function file(path, imagePath, bundle) {
    await checkSpace();
    const bundlePath = bundle?.path ?? null;
    const info = resourceContext(imagePath, bundlePath, label);
    info.bundleAssignment = bundle?.assignment ?? "unbundled";
    info.bundleEvidence = bundle?.evidence ?? null;
    const format = extname(path);
    report.counts.resourceFiles++;
    report.formats[format] ??= { files: 0, parsed: 0, failed: 0, rows: 0 };
    report.formats[format].files++;
    const top = "/" + imagePath.split("/")[1];
    report.topLevel[top] ??= { files: 0, parsed: 0, failed: 0, rows: 0 };
    report.topLevel[top].files++;
    if (bundlePath) bundles.add(bundlePath);
    else report.counts.unbundledFiles++;
    let bytes, parsed;
    try {
      const handle = await open(
        path,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.dev !== sourceDevice) {
          throw new Error(
            "Resource is not a regular file on the input filesystem",
          );
        }
        if (stat.size > 64 * 1024 ** 2) {
          throw new Error("Resource exceeds the 64 MiB parser limit");
        }
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      info.bytes = bytes.length;
      info.sha256 = hash(bytes);
      let decoded;
      info.decodeAttempts = 1;
      try {
        decoded = decode(bytes);
      } catch (error) {
        if (error.code !== "ETIMEDOUT") throw error;
        info.decodeAttempts = 2;
        info.retryReason = "ETIMEDOUT";
        report.counts.decodeRetries++;
        decoded = decode(bytes);
      }
      parsed = resourceRows(decoded, info.resourcePath);
    } catch (error) {
      report.counts.failedFiles++;
      report.formats[format].failed++;
      report.topLevel[top].failed++;
      if (bytes) {
        info.quarantinePath = `quarantine/${info.resourceId}${format}`;
        await writeFile(join(destination, info.quarantinePath), bytes, {
          flag: "wx",
        });
        report.counts.quarantinedFiles++;
      }
      await issue(imagePath, "resource", error);
      await writers.files.line({
        ...info,
        status: "failed",
        error: error.message,
      });
      return;
    }
    // Output failures are fatal, never confused with an unreadable resource.
    for (const row of parsed) {
      await writers.rows.line({
        resourceId: info.resourceId,
        language: row.language,
        key: row.key,
        targetKind: row.targetKind,
        target: row.target,
      });
      languages.add(row.language);
      report.counts.rows++;
      report
        .counts[row.targetKind === "text" ? "textRows" : "structuredRows"]++;
    }
    report.counts.parsedFiles++;
    if (!parsed.length) report.counts.emptyFiles++;
    report.formats[format].parsed++;
    report.formats[format].rows += parsed.length;
    report.topLevel[top].parsed++;
    report.topLevel[top].rows += parsed.length;
    await writers.files.line({
      ...info,
      status: "parsed",
      format: format.slice(1),
      rows: parsed.length,
      tablePath: parsed[0]?.tablePath ?? info.resourcePath,
    });
  }
  async function assignment(path, imagePath, inherited) {
    return await assignBundle({
      path,
      imagePath,
      inherited,
      policy: bundlePolicy,
      device: sourceDevice,
      decode: decode === decodePlist ? readBundleMetadata : decode,
      onIssue: async (p, error) => {
        report.counts.bundleMetadataIssues++;
        await issue(p, "bundle-metadata", error);
      },
    });
  }
  async function walk(path, imagePath = "", bundle = null) {
    await checkSpace();
    let entries;
    try {
      const stat = await lstat(path);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error("Directory changed during scan");
      }
      if (stat.dev !== sourceDevice) {
        report.counts.crossDeviceDirectories++;
        await issue(
          imagePath,
          "boundary",
          new Error("Different filesystem; not traversed"),
        );
        return;
      }
      entries = await readdir(path, { withFileTypes: true });
      report.counts.directories++;
    } catch (error) {
      report.counts.enumerationErrors++;
      await issue(imagePath, "enumeration", error);
      return;
    }
    if (imagePath) bundle = await assignment(path, imagePath, bundle);
    for (
      const entry of entries.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0
      )
    ) {
      const nextImagePath = imagePath + "/" + entry.name;
      const nextPath = join(path, entry.name);
      if (entry.isSymbolicLink()) {
        report.counts.symlinks++;
        await writers.symlinks.line({
          imagePath: nextImagePath,
          reason: "not-followed",
        });
      } else if (entry.isDirectory()) {
        await walk(
          nextPath,
          nextImagePath,
          bundle,
        );
      } else if (entry.isFile()) {
        report.counts.files++;
        if (formats.has(extname(entry.name))) {
          await file(nextPath, nextImagePath, bundle);
        }
      }
    }
  }
  let fatal;
  try {
    await checkSpace(true);
    let inherited = null;
    if (subtree) {
      let ancestor = sourceRoot, imageAncestor = "";
      for (const part of subtree.split("/").slice(0, -1)) {
        ancestor = join(ancestor, part);
        imageAncestor += "/" + part;
        inherited = await assignment(ancestor, imageAncestor, inherited);
      }
    }
    await walk(scopePath, scopeImagePath, inherited);
    report.status =
      report.counts.failedFiles || report.counts.enumerationErrors ||
        report.counts.crossDeviceDirectories ||
        report.counts.bundleMetadataIssues
        ? "scanned-with-issues"
        : "complete-within-scope";
    if (!report.counts.resourceFiles) {
      throw new Error("No supported resources found");
    }
  } catch (error) {
    fatal = error;
    report.status = "aborted";
    report.fatalError = error.message;
  }
  for (const writer of Object.values(writers)) {
    try {
      await writer.close();
    } catch (error) {
      fatal ??= error;
      report.status = "aborted";
      report.fatalError = error.message;
    }
  }
  report.finishedAt = new Date().toISOString();
  report.bundlePaths = [...bundles].sort();
  report.languageCodes = [...languages].sort();
  await writeFile(
    join(destination, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" },
  );
  if (fatal) throw fatal;
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  try {
    const { values } = parseArgs({
      options: {
        root: { type: "string" },
        output: { type: "string" },
        label: { type: "string" },
        subtree: { type: "string" },
        "bundle-policy-version": { type: "string" },
      },
    });
    for (const key of ["root", "output", "label"]) {
      if (!values[key]) throw new Error(`--${key} is required`);
    }
    const report = await extractMountedImage({
      ...values,
      ...(values["bundle-policy-version"] === undefined ? {} : {
        bundlePolicyVersion: Number(values["bundle-policy-version"]),
      }),
      progress: (counts) => console.log(JSON.stringify({ progress: counts })),
    });
    console.log(
      JSON.stringify({ status: report.status, counts: report.counts }),
    );
    if (report.status !== "complete-within-scope") process.exitCode = 2;
  } catch (error) {
    console.error(error.stack);
    process.exitCode = 1;
  }
}
