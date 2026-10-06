// Read-only investigation of quarantined resources. Never assigns production languages.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, posix, resolve } from "node:path";
import { readJsonLines } from "../shared/localization-jsonl.mjs";
import { isDeepStrictEqual, parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { decodePlist } from "./extract-mounted-bundle.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const dictionary = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const inside = (root, path) => path === root || path.startsWith(root + "/");
const languageError =
  "Expected exactly one nonempty .lproj directory; refusing to guess language";

export function canonicalLanguage(value) {
  if (value === "English") return "en";
  if (typeof value !== "string" || value === "Base") return null;
  try {
    return Intl.getCanonicalLocales(value.replaceAll("_", "-"))[0] ?? null;
  } catch {
    return null;
  }
}

// These are observed private resource conventions, NOT a general Apple filename standard.
// Keep the raw token and path: locale canonicalization must not merge occurrences.
export function filenameEvidence(imagePath, bundleIdentifier) {
  const rules = [
    [
      "siri-interstitial-locale",
      "com.apple.siri.SiriTTSService",
      /^\/System\/Library\/PrivateFrameworks\/SiriTTSService\.framework\/Versions\/[^/]+\/Resources\/LocalizedStrings\/Interstitials\/([^/]+)\.strings$/,
    ],
    [
      "dictation-command-locale",
      "com.apple.inputmethod.ironwood",
      /^\/System\/Library\/Input Methods\/DictationIM\.app\/Contents\/Resources\/BuiltinCommandStrings\/([^/]+)\.strings$/,
    ],
    [
      "handwriting-locale",
      "com.apple.inputmethod.ChineseHandwriting",
      /^\/System\/Library\/Input Methods\/TrackpadIM\.app\/Contents\/PlugIns\/TIM_Extension\.appex\/Contents\/Resources\/(yue-Hant|zh-Hans|zh-Hant)\.strings$/,
    ],
    [
      "chinese-punctuation-locale",
      null,
      /^\/System\/Library\/(?:PrivateFrameworks\/CoreChineseEngine\.framework|TextInput\/TextInput_zh\.bundle)\/Versions\/[^/]+\/Resources\/CIMPunctuationDescription_(yue_Hant|zh_Hans|zh_Hant)\.strings$/,
    ],
  ];
  for (const [rule, identifier, pattern] of rules) {
    const match = imagePath.match(pattern);
    if (!match || (identifier && identifier !== bundleIdentifier)) continue;
    const language = canonicalLanguage(match[1]);
    if (language) {
      return {
        rule,
        rawToken: match[1],
        language,
        basis: "observed-filename-convention",
      };
    }
  }
  return null;
}

// Only remove one explicit locale directory, and retain the full container path.
export function tableIdentity(imagePath) {
  const parts = imagePath.split("/");
  const locales = parts.filter((part) => part.endsWith(".lproj"));
  if (locales.length > 1 || locales.includes(".lproj")) return null;
  return parts.filter((part) => !part.endsWith(".lproj")).join("/")
    .replace(/\.(strings|stringsdict|loctable)$/, "");
}

export function compareTable(data, other) {
  assert.ok(dictionary(data) && dictionary(other));
  const result = { equal: 0, different: 0, missing: 0 };
  for (const [key, value] of Object.entries(data)) {
    if (!Object.hasOwn(other, key)) result.missing++;
    else if (isDeepStrictEqual(value, other[key])) result.equal++;
    else result.different++;
  }
  return {
    ...result,
    coversAll: result.equal > 0 && result.different === 0 &&
      result.missing === 0,
  };
}

function contentHint(imagePath) {
  if (
    /\/SFSymbols\.framework\/.*\/CoreGlyphs(?:Private)?\.bundle\/Contents\/Resources\/(name_aliases|nofill_to_fill|semantic_to_descriptive_name)\.strings$/
      .test(imagePath)
  ) {
    return "symbol-identifier-mapping";
  }
  if (
    /\/Print Center\.app\/Contents\/Resources\/Kind\.strings$/.test(imagePath)
  ) return "printer-status-identifier-mapping";
  if (/\/(SupportLinks|URLUtilsNonLoc)\.strings$/.test(imagePath)) {
    return "url-table-candidate";
  }
  if (/\/Acknowledgments\.strings$/.test(imagePath)) return "acknowledgments";
  if (/\/symbol_restrictions\.strings$/.test(imagePath)) {
    return "symbol-usage-notices";
  }
  return null;
}

export function assessResource(file, data, metadata, comparisons = []) {
  assert.ok(dictionary(data), "Expected a resource dictionary");
  const entries = Object.entries(data);
  for (const [, value] of entries) {
    assert.ok(
      typeof value === "string" ||
        (file.imagePath.endsWith(".stringsdict") && dictionary(value)),
      "Invalid target type",
    );
  }
  const filename = filenameEvidence(file.imagePath, metadata?.identifier);
  const developmentLanguage = canonicalLanguage(metadata?.developmentRegion);
  const hint = contentHint(file.imagePath);
  const completeMatches = comparisons.filter((entry) => entry.coversAll);
  const matchingLanguages = [
    ...new Set(
      completeMatches.map((entry) => canonicalLanguage(entry.language)).filter(
        Boolean,
      ),
    ),
  ].sort();
  let category = "unresolved";
  if (!entries.length) category = "empty";
  else if (hint?.endsWith("mapping") || hint === "url-table-candidate") {
    category = "nontranslation-candidate";
  } else if (filename) category = "filename-language-candidate";
  else if (
    developmentLanguage && matchingLanguages.includes(developmentLanguage)
  ) category = "corroborated-development-language-candidate";
  else if (matchingLanguages.length === 1) {
    category = "matching-table-language-candidate";
  } else if (developmentLanguage) category = "development-language-only";
  return {
    category,
    entries: entries.length,
    textEntries:
      entries.filter(([, value]) => typeof value === "string").length,
    structuredEntries: entries.filter(([, value]) => dictionary(value)).length,
    // No confidence score and no accepted language: evidence is not a runtime declaration.
    acceptedLanguage: null,
    proposedLanguage: category === "filename-language-candidate"
      ? filename.language
      : category === "corroborated-development-language-candidate"
      ? developmentLanguage
      : category === "matching-table-language-candidate"
      ? matchingLanguages[0]
      : null,
    filenameEvidence: filename,
    developmentLanguage,
    filenameDiffersFromDevelopmentLanguage: Boolean(
      filename && developmentLanguage &&
        filename.language !== developmentLanguage,
    ),
    contentHint: hint,
    matchingLanguages,
    comparisons,
    samples: entries.slice(0, 3).map(([key, target]) => ({ key, target })),
  };
}

// Reject traversal, symlinks (including ancestors), devices and oversized files.
export async function safeRead(root, relativePath) {
  assert.equal(typeof relativePath, "string");
  const parts = relativePath.split("/");
  assert.ok(
    parts.every((part) => part && part !== "." && part !== ".."),
    "Unsafe relative path",
  );
  let current = root;
  const device = (await lstat(root)).dev;
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    const stat = await lstat(current);
    assert.ok(!stat.isSymbolicLink(), "Symlink is not allowed");
    assert.equal(stat.dev, device, "Different filesystem is not allowed");
    assert.ok(
      i === parts.length - 1 ? stat.isFile() : stat.isDirectory(),
      "Not a regular file/directory",
    );
    if (i === parts.length - 1) {
      assert.ok(stat.size <= 64 * 1024 ** 2, "File exceeds 64 MiB");
    }
  }
  const handle = await open(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

export async function verifiedFile(root, file, path) {
  const bytes = await safeRead(root, path);
  assert.equal(bytes.length, file.bytes, `Size mismatch: ${path}`);
  assert.equal(hash(bytes), file.sha256, `SHA-256 mismatch: ${path}`);
  return bytes;
}

export async function bundleMetadata(root, file, decode) {
  const bundlePath = file.bundlePath ??
    file.imagePath.match(/^(.+\.cifilter)\//)?.[1] ?? null;
  if (!bundlePath) return null;
  let directory = posix.dirname(file.imagePath);
  while (inside(bundlePath, directory)) {
    const imagePath = directory + "/Info.plist";
    try {
      const bytes = await safeRead(root, imagePath.slice(1));
      const data = decode(bytes);
      return {
        imagePath,
        sha256: hash(bytes),
        bundlePath,
        identifier: data.CFBundleIdentifier ?? null,
        developmentRegion: data.CFBundleDevelopmentRegion ?? null,
        declaredLocalizations: data.CFBundleLocalizations ?? null,
        bundleAssignment: file.bundlePath
          ? file.bundleAssignment
          : "cifilter-path-with-info-plist",
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    directory = posix.dirname(directory);
  }
  return null;
}

export async function inspectUnlocalizedResources(
  { root, input, output, decode = decodePlist },
) {
  const imageRoot = await realpath(root), scanRoot = await realpath(input);
  assert.notEqual(imageRoot, "/", "Refusing host root");
  const destination = join(
    await realpath(dirname(resolve(output))),
    basename(output),
  );
  assert.ok(
    !inside(imageRoot, destination) && !inside(scanRoot, destination),
    "Output must be outside inputs",
  );
  const scan = JSON.parse(await safeRead(scanRoot, "report.json"));
  assert.ok(
    ["scanned-with-issues", "complete-within-scope"].includes(scan.status),
  );
  assert.ok(
    (await lstat(join(scanRoot, "files.jsonl.gz"))).size <= 64 * 1024 ** 2,
    "Compressed index exceeds 64 MiB",
  );
  const indexHashes = {}, files = [];
  const ids = new Set();
  const peers = new Map();
  for await (
    const file of readJsonLines(scanRoot, "files.jsonl.gz", indexHashes)
  ) {
    assert.ok(!ids.has(file.resourceId), "Duplicate resource ID");
    ids.add(file.resourceId);
    assert.equal(file.sourceId, scan.source.sourceId);
    assert.ok(file.imagePath.startsWith("/"));
    if (file.status === "failed" && file.error === languageError) {
      files.push(file);
    }
  }
  assert.equal(
    ids.size,
    scan.counts.resourceFiles,
    "Index resource count differs from scan",
  );
  ids.clear();
  const wanted = new Set(
    files.map((file) => tableIdentity(file.imagePath)).filter(Boolean),
  );
  if (wanted.size) {
    const peerHashes = {};
    for await (
      const file of readJsonLines(scanRoot, "files.jsonl.gz", peerHashes)
    ) {
      if (file.status !== "parsed") continue;
      const identity = tableIdentity(file.imagePath);
      if (!wanted.has(identity)) continue;
      if (!peers.has(identity)) peers.set(identity, []);
      peers.get(identity).push(file);
    }
    assert.deepEqual(peerHashes, indexHashes, "Index changed between passes");
  }
  const records = [];
  const counts = {
    files: 0,
    entries: 0,
    textEntries: 0,
    structuredEntries: 0,
    errors: 0,
    proposedLanguageFiles: 0,
    proposedLanguageEntries: 0,
  };
  const categories = {};
  const decodedPeers = new Map();
  for (
    const file of files.filter((file) =>
      file.status === "failed" && file.error === languageError
    )
  ) {
    const record = { ...file };
    counts.files++;
    try {
      assert.ok(
        /^quarantine\/[a-f0-9]{64}\.(strings|stringsdict)$/.test(
          file.quarantinePath,
        ),
      );
      const bytes = await verifiedFile(scanRoot, file, file.quarantinePath);
      // Verify that metadata/peers come from an image containing the exact quarantined resource.
      await verifiedFile(imageRoot, file, file.imagePath.slice(1));
      const data = decode(bytes);
      const metadata = await bundleMetadata(imageRoot, file, decode);
      const comparisons = [];
      for (const peer of peers.get(tableIdentity(file.imagePath)) ?? []) {
        if (peer.bundlePath !== file.bundlePath) continue;
        if (!decodedPeers.has(peer.resourceId)) {
          decodedPeers.set(
            peer.resourceId,
            decode(
              await verifiedFile(imageRoot, peer, peer.imagePath.slice(1)),
            ),
          );
        }
        const peerData = decodedPeers.get(peer.resourceId);
        let localized;
        if (extname(peer.imagePath) === ".loctable") {
          localized = Object.entries(peerData).filter(([language]) =>
            language !== "LocProvenance"
          );
        } else {
          if (extname(peer.imagePath) !== extname(file.imagePath)) continue;
          const locale = peer.imagePath.split("/").filter((part) =>
            part.endsWith(".lproj")
          );
          if (locale.length !== 1) continue;
          localized = [[locale[0].slice(0, -6), peerData]];
        }
        for (const [language, targets] of localized) {
          comparisons.push({
            resourceId: peer.resourceId,
            imagePath: peer.imagePath,
            sha256: peer.sha256,
            language,
            ...compareTable(data, targets),
          });
        }
      }
      record.metadata = metadata;
      record.assessment = assessResource(file, data, metadata, comparisons);
      for (const key of ["entries", "textEntries", "structuredEntries"]) {
        counts[key] += record.assessment[key];
      }
      const category = record.assessment.category;
      categories[category] ??= { files: 0, entries: 0 };
      categories[category].files++;
      categories[category].entries += record.assessment.entries;
      if (record.assessment.proposedLanguage) {
        counts.proposedLanguageFiles++;
        counts.proposedLanguageEntries += record.assessment.entries;
      }
    } catch (error) {
      counts.errors++;
      record.inspectionError = error.message;
    }
    records.push(record);
  }
  const report = {
    formatVersion: 1,
    status: counts.errors ? "inspection-with-errors" : "inspected-not-imported",
    createdAt: new Date().toISOString(),
    sourceId: scan.source.sourceId,
    imageRoot,
    scanRoot,
    indexSha256: indexHashes["files.jsonl.gz"],
    counts,
    categories,
    limitations: [
      "No DB, original scan, quarantine file or language assignment was changed.",
      "Filename rules are observed conventions, not a universal Apple specification or runtime verification.",
      "Development region alone does not prove the language of a global resource; even one file can contain mixed content.",
      "Exact table matches are evidence only; identical names or text across unrelated bundles are not used.",
      "Nontranslation candidates are review hints, not deletions; all originals and their context remain available.",
      "Original and peer hashes are checked, but this does not reauthenticate the entire mounted image.",
    ],
  };
  await mkdir(destination); // Refuse overwriting a previous investigation.
  await writeFile(
    join(destination, "files.jsonl"),
    records.map((record) => JSON.stringify(record) + "\n").join(""),
    { flag: "wx" },
  );
  await writeFile(
    join(destination, "report.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" },
  );
  return report;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      root: { type: "string" },
      input: { type: "string" },
      output: { type: "string" },
    },
  });
  if (!values.root || !values.input || !values.output) {
    throw new Error("--root, --input and --output are required");
  }
  const report = await inspectUnlocalizedResources(values);
  console.log(JSON.stringify(report, null, 2));
  if (report.counts.errors) process.exitCode = 2;
}
