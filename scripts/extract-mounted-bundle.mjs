// Diagnostic prototype: no downloading, mounting, DB writes or Bundle fallbacks.
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  writeFile,
} from "node:fs/promises";
import {
  basename,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from "node:path";
import { spawnSync } from "node:child_process";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

const extensions = new Set([".strings", ".loctable", ".stringsdict"]);
// v2 preserves dictionary-valued .strings (e.g. FSPersonalities) without
// flattening nested keys or treating their contents as confirmed translations.
export const resourceParserPolicy = Object.freeze({
  version: 2,
  stringsDictionaryTargets: "preserve-as-structured",
  topLevelTargets: ["string", "dictionary"],
});
const bundleExtensions = new Set([
  ".app",
  ".framework",
  ".bundle",
  ".xpc",
  ".appex",
  ".plugin",
  ".prefPane",
  ".service",
  ".qlgenerator",
  ".mdimporter",
]);
const dictionary = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const inside = (parent, child) => {
  const path = relative(parent, child);
  return path === "" ||
    (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
};

export function decodePlist(bytes) {
  const result = spawnSync("/usr/bin/plutil", [
    "-convert",
    "json",
    "-o",
    "-",
    "--",
    "-",
  ], {
    input: bytes,
    maxBuffer: 64 * 1024 * 1024,
    timeout: 30000,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`plutil: ${String(result.stderr || result.stdout).trim()}`);
  }
  return JSON.parse(result.stdout.toString("utf8"));
}

export function resourceRows(data, resourcePath) {
  if (!dictionary(data)) {
    throw new Error("Resource is not a property-list dictionary");
  }
  const filename = basename(resourcePath);
  const format = extname(filename).slice(1);
  const rows = [];
  function add(language, key, target, tablePath) {
    if (typeof target !== "string" && !dictionary(target)) {
      throw new Error(`Unsupported target type: ${language}: ${key}`);
    }
    rows.push({
      resourcePath,
      tablePath,
      filename,
      format,
      language,
      key,
      targetKind: typeof target === "string" ? "text" : "structured",
      target,
    });
  }
  if (format === "loctable") {
    for (const language of Object.keys(data).sort()) {
      if (language === "LocProvenance") continue;
      if (!dictionary(data[language])) {
        throw new Error(`Invalid language dictionary: ${language}`);
      }
      for (const key of Object.keys(data[language]).sort()) {
        add(language, key, data[language][key], resourcePath);
      }
    }
  } else if (format === "strings" || format === "stringsdict") {
    const parts = resourcePath.split("/");
    const languages = parts.slice(0, -1).filter((part) =>
      part.endsWith(".lproj")
    );
    if (languages.length !== 1 || languages[0] === ".lproj") {
      throw new Error(
        "Expected exactly one nonempty .lproj directory; refusing to guess language",
      );
    }
    const language = languages[0].slice(0, -6);
    // Remove only the locale component, keeping table subdirectories distinct.
    const tablePath = parts.filter((part) => part !== languages[0]).join("/");
    for (const key of Object.keys(data).sort()) {
      add(language, key, data[key], tablePath);
    }
  } else throw new Error(`Unsupported resource format: ${format}`);
  return rows;
}

export async function extractMountedBundle(
  { root, bundle, output, kind, label },
) {
  if (
    !["mounted-image", "host-directory", "fixture"].includes(kind) || !label
  ) {
    throw new Error(
      "An explicit source kind and label are required (labels are not verified OS identities)",
    );
  }
  if (
    !bundle || isAbsolute(bundle) ||
    bundle.split(/[\\/]/).some((part) => !part || part === "." || part === "..")
  ) {
    throw new Error(
      "--bundle must be a nonempty root-relative path without . or .. components",
    );
  }
  const sourceRoot = await realpath(root);
  const bundleRoot = join(sourceRoot, bundle);
  // Reject symlinks in the selected bundle's ancestors as well as its contents.
  let current = sourceRoot;
  for (const part of bundle.split("/")) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Not a physical directory: ${current}`);
    }
  }
  const destination = resolve(output);
  const actualDestination = join(
    await realpath(resolve(destination, "..")),
    basename(destination),
  );
  if (inside(bundleRoot, actualDestination)) {
    throw new Error("Output must not be inside the input bundle");
  }
  // Never replace existing artifacts, even an empty directory.
  await mkdir(destination);
  const report = {
    formatVersion: 1,
    status: "incomplete",
    startedAt: new Date().toISOString(),
    source: {
      kind,
      label,
      root: sourceRoot,
      bundlePath: `/${bundle}`,
      identityVerified: false,
    },
    parser: {
      name: "mounted-bundle-prototype",
      version: 2,
      node: process.version,
      platform: process.platform,
    },
    resourceParserPolicy,
    files: [],
    exclusions: [],
    errors: [],
    counts: { resources: 0, textRows: 0, structuredRows: 0 },
    limitations: [
      "Single bundle only; nested bundles and symlinks are reported but not followed.",
      "Only .loctable, .strings and .stringsdict are read. Compiled UI resources and assets are not decoded.",
      "Structured targets are preserved, not converted to searchable text. Output is not a DB import format.",
      "Source label is user supplied; this does not verify IPSW authenticity, mounting or BuildManifest identity.",
    ],
  };
  const rowsFile = await open(join(destination, "rows.jsonl"), "wx");
  try {
    async function walk(directory) {
      let entries;
      try {
        entries = await readdir(directory, { withFileTypes: true });
      } catch (error) {
        report.errors.push({
          path: relative(bundleRoot, directory),
          message: error.message,
        });
        return;
      }
      for (
        const entry of entries.sort((a, b) =>
          a.name < b.name ? -1 : a.name > b.name ? 1 : 0
        )
      ) {
        const path = join(directory, entry.name);
        const resourcePath = relative(bundleRoot, path).split(sep).join("/");
        if (entry.isSymbolicLink()) {
          report.exclusions.push({
            path: resourcePath,
            reason: "symlink-not-followed",
          });
        } else if (entry.isDirectory()) {
          if (bundleExtensions.has(extname(entry.name))) {
            report.exclusions.push({
              path: resourcePath,
              reason: "nested-bundle-extract-separately",
            });
          } else await walk(path);
        } else if (entry.isFile() && extensions.has(extname(entry.name))) {
          const file = { path: resourcePath, status: "failed" };
          report.files.push(file);
          try {
            // No target code is executed. O_NOFOLLOW also rejects a replaced file symlink.
            const handle = await open(
              path,
              constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            let bytes;
            try {
              bytes = await handle.readFile();
            } finally {
              await handle.close();
            }
            file.bytes = bytes.length;
            file.sha256 = createHash("sha256").update(bytes).digest("hex");
            const rows = resourceRows(decodePlist(bytes), resourcePath);
            for (const row of rows) {
              await rowsFile.writeFile(
                JSON.stringify({ bundlePath: `/${bundle}`, ...row }) + "\n",
              );
              report.counts[
                row.targetKind === "text" ? "textRows" : "structuredRows"
              ]++;
            }
            file.rows = rows.length;
            file.status = "ok";
            report.counts.resources++;
          } catch (error) {
            report.errors.push({ path: resourcePath, message: error.message });
          }
        }
      }
    }
    await walk(bundleRoot);
    if (!report.files.length) {
      report.errors.push({
        path: "",
        message: "No supported resource files found",
      });
    }
  } catch (error) {
    report.errors.push({ path: "", message: error.message });
    throw error;
  } finally {
    await rowsFile.close();
    report.finishedAt = new Date().toISOString();
    report.status = report.errors.length || !report.counts.resources
      ? "incomplete"
      : "complete-within-scope";
    await writeFile(
      join(destination, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
      { flag: "wx" },
    );
  }
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
        bundle: { type: "string" },
        output: { type: "string" },
        kind: { type: "string" },
        label: { type: "string" },
        help: { type: "boolean" },
      },
    });
    if (values.help) {
      console.log(
        "node scripts/extract-mounted-bundle.mjs --root MOUNT --bundle System/Library/Frameworks/Contacts.framework --output NEW_DIR --kind mounted-image --label SOURCE_ID",
      );
    } else {
      for (const key of ["root", "bundle", "output", "kind", "label"]) {
        if (!values[key]) throw new Error(`--${key} is required`);
      }
      const report = await extractMountedBundle(values);
      console.log(
        JSON.stringify({
          output: resolve(values.output),
          status: report.status,
          counts: report.counts,
          errors: report.errors.length,
        }),
      );
      if (report.status === "incomplete") process.exitCode = 1;
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
