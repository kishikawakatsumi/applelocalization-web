// Lossless occurrence-oriented intermediate format. No SQL, DB, network or mounted image required.
import assert from "node:assert/strict";
import process from "node:process";
import { packageOwnership } from "./package-ownership.mjs";
import { createHash } from "node:crypto";
import { mkdir, realpath, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { decodePlist } from "../extraction/extract-mounted-bundle.mjs";
import {
  filenameEvidence,
  safeRead,
  verifiedFile,
} from "../extraction/inspect-unlocalized-resources.mjs";
import {
  JsonLineWriter,
  readJsonLines,
  sha256,
} from "../shared/localization-jsonl.mjs";

const streams = [
  "sources",
  "resources",
  "tables",
  "occurrences",
  "issues",
  "symlinks",
];
const inside = (root, path) => path === root || path.startsWith(root + "/");
const dictionary = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const failure =
  "Expected exactly one nonempty .lproj directory; refusing to guess language";

export function tableContext(file, supplement = null) {
  const format = extname(file.imagePath).slice(1);
  assert.ok(["strings", "stringsdict", "loctable"].includes(format));
  let path = file.imagePath, basis;
  if (supplement) {
    const evidence = supplement.languageEvidence;
    // Separate field, not a fabricated filesystem path. Scoped family+directory only.
    path = dirname(file.imagePath);
    basis = "filename-family:" + evidence.rule;
  } else if (format === "loctable") basis = "loctable-file";
  else {
    const parts = file.imagePath.split("/");
    const locales = parts.slice(0, -1).filter((part) =>
      part.endsWith(".lproj")
    );
    assert.ok(
      locales.length === 1 && locales[0] !== ".lproj",
      "Invalid localized table path",
    );
    path = parts.filter((part) => part !== locales[0]).join("/");
    basis = "lproj-relative-path";
  }
  const identity = [file.sourceId, file.bundlePath, format, basis, path];
  return {
    tableId: sha256(JSON.stringify(identity)),
    sourceId: file.sourceId,
    bundlePath: file.bundlePath,
    format,
    basis,
    path,
  };
}

async function compilePackage(
  {
    scan,
    supplement,
    ownership = null,
    decode = decodePlist,
    emit,
    binary,
    progress = () => {},
  },
) {
  const scanHashes = {}, supplementHashes = {};
  const scanBytes = await safeRead(scan, "report.json"),
    supplementBytes = await safeRead(supplement, "report.json");
  scanHashes["report.json"] = sha256(scanBytes);
  supplementHashes["report.json"] = sha256(supplementBytes);
  const scanReport = JSON.parse(scanBytes),
    supplementReport = JSON.parse(supplementBytes);
  assert.ok(
    ["scanned-with-issues", "complete-within-scope"].includes(
      scanReport.status,
    ),
  );
  assert.equal(supplementReport.status, "extracted-not-imported");
  assert.equal(supplementReport.outputKind, "filename-language-supplement");
  assert.equal(supplementReport.policy.version, 1);
  const sourceId = scanReport.source.sourceId;
  assert.equal(supplementReport.sourceId, sourceId);
  assert.equal(
    supplementReport.inputs.scanReportSha256,
    scanHashes["report.json"],
  );
  const files = new Map(),
    supplements = new Map(),
    tables = new Map(),
    resources = new Map();
  const counts = {
    resources: 0,
    primaryParsedFiles: 0,
    supplementedFiles: 0,
    unresolvedFiles: 0,
    tables: 0,
    occurrences: 0,
    primaryRows: 0,
    supplementRows: 0,
    textRows: 0,
    structuredRows: 0,
    quarantinedFiles: 0,
    issues: 0,
    symlinks: 0,
  };
  for await (const file of readJsonLines(scan, "files.jsonl.gz", scanHashes)) {
    assert.ok(!files.has(file.resourceId), "Duplicate resource ID");
    assert.equal(file.sourceId, sourceId);
    assert.equal(
      file.resourceId,
      sha256(JSON.stringify([sourceId, file.imagePath])),
    );
    assert.ok(
      file.imagePath.startsWith("/") &&
        file.imagePath.split("/").slice(1).every((part) =>
          part && part !== "." && part !== ".."
        ),
    );
    assert.ok(
      file.bundlePath === null || inside(file.bundlePath, file.imagePath),
    );
    assert.equal(
      file.resourcePath,
      file.bundlePath
        ? file.imagePath.slice(file.bundlePath.length + 1)
        : file.imagePath.slice(1),
    );
    assert.ok(["parsed", "failed"].includes(file.status));
    if (file.status === "parsed") {
      assert.equal(file.format, extname(file.imagePath).slice(1));
    }
    files.set(file.resourceId, file);
  }
  assert.equal(
    scanHashes["files.jsonl.gz"],
    supplementReport.inputs.indexSha256,
  );
  assert.equal(files.size, scanReport.counts.resourceFiles);
  const correction = ownership
    ? await packageOwnership({
      directory: ownership,
      files,
      scanReport,
      scanHashes,
    })
    : null;
  if (correction) counts.ownershipAdjustedResources = correction.changes.size;
  for await (
    const file of readJsonLines(supplement, "files.jsonl.gz", supplementHashes)
  ) {
    assert.ok(
      !supplements.has(file.resourceId),
      "Duplicate supplemented resource",
    );
    const original = files.get(file.resourceId);
    assert.ok(
      original && original.status === "failed" && original.error === failure,
      "Supplement may only resolve a language-failed resource",
    );
    assert.equal(file.status, "parsed-with-filename-language");
    for (const key of Object.keys(original)) {
      if (key !== "status") {
        assert.deepEqual(
          file[key],
          original[key],
          `Supplement provenance mismatch: ${key}`,
        );
      }
    }
    assert.equal(file.originalScanStatus, "failed");
    const evidence = file.languageEvidence;
    assert.equal(evidence.version, 1);
    assert.equal(evidence.languageBasis, "filename-convention");
    assert.equal(evidence.languageStatus, "inferred");
    assert.equal(evidence.resourceSha256, original.sha256);
    const inferred = filenameEvidence(
      file.imagePath,
      evidence.metadata?.identifier,
    );
    assert.ok(inferred, "Unsupported filename rule");
    for (const key of ["rule", "rawToken", "language"]) {
      assert.equal(evidence[key], inferred[key]);
    }
    supplements.set(file.resourceId, file);
  }
  const deferred = new Map();
  for await (
    const file of readJsonLines(
      supplement,
      "deferred.jsonl.gz",
      supplementHashes,
    )
  ) {
    assert.ok(
      !deferred.has(file.resourceId) && !supplements.has(file.resourceId),
    );
    assert.equal(files.get(file.resourceId)?.status, "failed");
    assert.equal(files.get(file.resourceId)?.imagePath, file.imagePath);
    deferred.set(file.resourceId, file);
  }
  assert.equal(supplements.size, supplementReport.counts.extractedFiles);
  assert.equal(deferred.size, supplementReport.counts.deferredFiles);
  assert.equal(
    deferred.size + supplements.size,
    supplementReport.counts.inspectedFiles,
  );
  for (const file of files.values()) {
    if (file.status === "failed" && file.error === failure) {
      assert.ok(
        supplements.has(file.resourceId) || deferred.has(file.resourceId),
        "Unaccounted language failure",
      );
    }
  }
  await emit("sources", {
    sourceId,
    primaryScan: scanReport,
    filenameSupplement: supplementReport,
    ...(correction ? { ownershipOverlay: correction.report } : {}),
  });
  const supplementalTargets = new Map();
  for (const file of files.values()) {
    const added = supplements.get(file.resourceId);
    const ownershipChange = correction?.changes.get(file.resourceId);
    const effective = ownershipChange
      ? {
        ...file,
        bundlePath: ownershipChange.after.bundlePath,
        bundleName: basename(ownershipChange.after.bundlePath),
        resourcePath: ownershipChange.after.resourcePath,
        bundleAssignment: ownershipChange.after.assignment,
        bundleEvidence: ownershipChange.after.evidence,
      }
      : file;
    const readable = file.status === "parsed" || Boolean(added);
    if (ownershipChange && file.status === "parsed") {
      effective.tablePath = file.rows > 0 && file.format !== "loctable"
        ? effective.resourcePath.split("/").filter((p) => !p.endsWith(".lproj"))
          .join("/")
        : effective.resourcePath;
    }
    const table = readable ? tableContext(effective, added) : null;
    if (table && !tables.has(table.tableId)) {
      tables.set(table.tableId, table);
      await emit("tables", table);
    }
    const rows = added?.rows ?? (file.status === "parsed" ? file.rows : 0);
    assert.ok(Number.isSafeInteger(rows) && rows >= 0);
    const resource = {
      resourceId: file.resourceId,
      sourceId,
      tableId: table?.tableId ?? null,
      status: added
        ? "supplemented-inferred"
        : file.status === "parsed"
        ? "parsed"
        : "unresolved",
      rows,
      original: file,
      supplement: added ?? null,
      deferred: deferred.get(file.resourceId) ?? null,
      ...(correction
        ? { effective, ownershipCorrection: ownershipChange ?? null }
        : {}),
    };
    resources.set(file.resourceId, { resource, seen: 0 });
    await emit("resources", resource);
    counts.resources++;
    counts[
      added
        ? "supplementedFiles"
        : file.status === "parsed"
        ? "primaryParsedFiles"
        : "unresolvedFiles"
    ]++;
    if (file.quarantinePath) {
      assert.match(
        file.quarantinePath,
        /^quarantine\/[a-f0-9]{64}\.(strings|stringsdict|loctable)$/,
      );
      const bytes = await verifiedFile(scan, file, file.quarantinePath);
      await binary(file.quarantinePath, bytes);
      counts.quarantinedFiles++;
      if (added) {
        const data = decode(bytes);
        assert.ok(dictionary(data));
        assert.equal(Object.keys(data).length, rows);
        supplementalTargets.set(file.resourceId, new Map(Object.entries(data)));
      }
    } else assert.ok(!added, "Supplement needs a quarantined original");
  }
  counts.tables = tables.size;
  const languages = new Map(), bundles = new Map();
  let lastProgress = Date.now();
  for (
    const [origin, directory, hashes] of [["primary", scan, scanHashes], [
      "supplement",
      supplement,
      supplementHashes,
    ]]
  ) {
    for await (const row of readJsonLines(directory, "rows.jsonl.gz", hashes)) {
      const state = resources.get(row.resourceId);
      assert.ok(state, "Row has no resource");
      const { resource } = state,
        file = resource.original,
        added = resource.supplement;
      assert.ok(
        origin === "primary"
          ? file.status === "parsed" && !added
          : Boolean(added),
        "Row belongs to the wrong input stream",
      );
      assert.equal(typeof row.language, "string");
      assert.ok(row.language.length > 0);
      assert.equal(typeof row.key, "string");
      assert.ok(
        row.targetKind === "text"
          ? typeof row.target === "string"
          : row.targetKind === "structured" && dictionary(row.target),
      );
      let basis, status, raw;
      if (added) {
        const evidence = added.languageEvidence;
        assert.equal(row.language, evidence.language);
        assert.equal(row.languageRaw, evidence.rawToken);
        assert.equal(row.languageBasis, evidence.languageBasis);
        assert.equal(row.languageStatus, evidence.languageStatus);
        const targets = supplementalTargets.get(row.resourceId);
        assert.ok(
          targets.has(row.key),
          "Duplicate or unknown supplemental key",
        );
        assert.equal(row.targetKind, "text");
        assert.deepEqual(
          row.target,
          targets.get(row.key),
          "Supplement differs from quarantined original",
        );
        targets.delete(row.key);
        basis = "filename-convention";
        status = "inferred";
        raw = row.languageRaw;
      } else {
        raw = row.language;
        basis = file.format === "loctable"
          ? "loctable-language-key"
          : "lproj-directory";
        status = raw === "Base" ? "base-unresolved" : "explicit-code";
        if (basis === "lproj-directory") {
          const locales = file.resourcePath.split("/").slice(0, -1).filter((
            part,
          ) => part.endsWith(".lproj"));
          assert.equal(locales.length, 1);
          assert.equal(raw, locales[0].slice(0, -6));
        } else assert.notEqual(raw, "LocProvenance");
      }
      state.seen++;
      assert.ok(state.seen <= resource.rows, "Too many rows for resource");
      counts.occurrences++;
      counts[origin === "primary" ? "primaryRows" : "supplementRows"]++;
      counts[row.targetKind === "text" ? "textRows" : "structuredRows"]++;
      await emit("occurrences", {
        id: counts.occurrences,
        resourceId: row.resourceId,
        resourceOrdinal: state.seen,
        language: row.language,
        languageRaw: raw,
        languageBasis: basis,
        languageStatus: status,
        key: row.key,
        targetKind: row.targetKind,
        target: row.target,
      });
      const languageKey = JSON.stringify([row.language, raw, basis, status]);
      if (!languages.has(languageKey)) {
        languages.set(languageKey, {
          language: row.language,
          raw,
          basis,
          status,
          rows: 0,
        });
      }
      languages.get(languageKey).rows++;
      const bundle = (resource.effective ?? file).bundlePath;
      if (!bundles.has(bundle)) {
        bundles.set(bundle, { bundlePath: bundle, rows: 0 });
      }
      bundles.get(bundle).rows++;
      if (Date.now() - lastProgress > 10000) {
        await progress({ ...counts });
        lastProgress = Date.now();
      }
    }
  }
  for (const { resource, seen } of resources.values()) {
    assert.equal(
      seen,
      resource.rows,
      `Row count mismatch: ${resource.resourceId}`,
    );
  }
  for (const targets of supplementalTargets.values()) {
    assert.equal(targets.size, 0);
  }
  assert.equal(counts.primaryRows, scanReport.counts.rows);
  assert.equal(counts.supplementRows, supplementReport.counts.rows);
  assert.equal(
    counts.textRows,
    scanReport.counts.textRows + supplementReport.counts.textRows,
  );
  assert.equal(
    counts.structuredRows,
    scanReport.counts.structuredRows + supplementReport.counts.structuredRows,
  );
  assert.equal(counts.primaryParsedFiles, scanReport.counts.parsedFiles);
  assert.equal(
    counts.unresolvedFiles + counts.supplementedFiles,
    scanReport.counts.failedFiles,
  );
  assert.equal(counts.quarantinedFiles, scanReport.counts.quarantinedFiles);
  for (const name of ["issues", "symlinks"]) {
    for await (
      const record of readJsonLines(scan, name + ".jsonl.gz", scanHashes)
    ) {
      assert.ok(record.imagePath);
      await emit(name, record);
      counts[name]++;
    }
  }
  assert.equal(
    counts.issues,
    scanReport.counts.failedFiles + scanReport.counts.enumerationErrors +
      scanReport.counts.crossDeviceDirectories +
      (scanReport.counts.bundleMetadataIssues ?? 0),
  );
  assert.equal(counts.symlinks, scanReport.counts.symlinks);
  for (const name of ["files", "rows", "deferred"]) {
    assert.equal(
      supplementHashes[name + ".jsonl.gz"],
      supplementReport.outputHashes[name],
      `Supplement checksum mismatch: ${name}`,
    );
  }
  const catalog = {
    sourceId,
    languages: [...languages.values()].sort((a, b) =>
      JSON.stringify(a).localeCompare(JSON.stringify(b))
    ),
    bundles: [...bundles.values()].sort((a, b) =>
      (a.bundlePath ?? "").localeCompare(b.bundlePath ?? "")
    ),
  };
  return {
    sourceId,
    counts,
    inputs: {
      scan: scanHashes,
      supplement: supplementHashes,
      ...(correction ? { ownership: correction.hashes } : {}),
    },
    catalog,
  };
}

async function runPackage(options, audit) {
  const scan = await realpath(options.scan),
    supplement = await realpath(options.supplement);
  const ownership = options.ownership
    ? await realpath(options.ownership)
    : null;
  const destination = audit ? await realpath(options.input) : join(
    await realpath(dirname(resolve(options.output))),
    basename(options.output),
  );
  assert.ok(
    !inside(scan, destination) && !inside(supplement, destination) &&
      (!ownership || !inside(ownership, destination)),
    "Output must be outside inputs",
  );
  const writers = {},
    logical = Object.fromEntries(
      streams.map((name) => [name, createHash("sha256")]),
    );
  const binaryHashes = {}, outputHashes = {};
  async function space() {
    const stat = await statfs(audit ? destination : dirname(destination));
    assert.ok(
      stat.bavail * stat.bsize >= (options.minimumFreeBytes ?? 10 * 1024 ** 3),
      "Insufficient free space",
    );
  }
  if (!audit) {
    await space();
    await mkdir(destination);
    await mkdir(join(destination, "quarantine"));
    for (const name of streams) {
      writers[name] = new JsonLineWriter(join(destination, name + ".jsonl.gz"));
    }
  }
  try {
    const summary = await compilePackage({
      ...options,
      scan,
      supplement,
      ownership,
      emit: async (name, record) => {
        const text = JSON.stringify(record) + "\n";
        logical[name].update(text);
        if (!audit) await writers[name].line(text);
      },
      binary: async (path, bytes) => {
        binaryHashes[path] = sha256(bytes);
        if (audit) {
          assert.equal(
            sha256(await safeRead(destination, path)),
            binaryHashes[path],
            "Quarantine copy mismatch",
          );
        } else await writeFile(join(destination, path), bytes, { flag: "wx" });
      },
      progress: async (counts) => {
        if (!audit) await space();
        options.progress?.(counts);
      },
    });
    const contentHashes = Object.fromEntries(
      streams.map((name) => [name, logical[name].digest("hex")]),
    );
    const catalogBytes = JSON.stringify(summary.catalog, null, 2) + "\n";
    const { catalog: _catalog, ...rest } = summary;
    const expected = {
      formatVersion: ownership ? 2 : 1,
      outputKind: "localization-occurrence-package",
      ...rest,
      contentHashes,
      binaryHashes,
      catalogSha256: sha256(catalogBytes),
    };
    if (audit) {
      const report = JSON.parse(await safeRead(destination, "report.json"));
      assert.equal(report.status, "prepared-not-imported");
      for (const [key, value] of Object.entries(expected)) {
        assert.deepEqual(report[key], value, `Package mismatch: ${key}`);
      }
      for (const name of streams) {
        const hash = createHash("sha256");
        let checkedRecords = 0, lastProgress = Date.now();
        for await (
          const row of readJsonLines(
            destination,
            name + ".jsonl.gz",
            outputHashes,
          )
        ) {
          hash.update(JSON.stringify(row) + "\n");
          checkedRecords++;
          if (Date.now() - lastProgress > 10000) {
            options.progress?.({
              stage: "verify-output",
              stream: name,
              checkedRecords,
            });
            lastProgress = Date.now();
          }
        }
        assert.equal(
          hash.digest("hex"),
          contentHashes[name],
          `Content mismatch: ${name}`,
        );
        assert.equal(
          outputHashes[name + ".jsonl.gz"],
          report.outputHashes[name],
          `Output checksum mismatch: ${name}`,
        );
      }
      assert.equal(
        sha256(await safeRead(destination, "catalog.json")),
        expected.catalogSha256,
      );
      return {
        status: "package-content-verified",
        sourceId: summary.sourceId,
        counts: summary.counts,
      };
    }
    for (const name of streams) {
      outputHashes[name] = await writers[name].close();
    }
    await writeFile(join(destination, "catalog.json"), catalogBytes, {
      flag: "wx",
    });
    const report = {
      ...expected,
      status: "prepared-not-imported",
      createdAt: new Date().toISOString(),
      outputHashes,
      limitations: [
        "No DB import, text deduplication or source/translation pairing. All occurrences and original issues remain.",
        "Table IDs express scoped correspondence candidates, not proof that matching keys mean the same thing.",
        "Explicit locale codes are retained as-is; Base is unresolved, not silently mapped to English.",
        "Primary rows are verified against the saved extraction, not re-extracted from the OS image. Supplement rows are also checked against quarantined originals.",
        "Input labels do not independently authenticate OS version/build. Original reports and their hashes are retained.",
        ...(ownership
          ? [
            "Format v2 uses resource.effective for corrected ownership and table grouping; resource.original and ownershipCorrection retain the unchanged scan and before/after evidence. Consumers must explicitly support v2.",
            "Ownership evidence is checked against the pinned overlay and original index; this offline package build does not re-read OS metadata.",
          ]
          : []),
      ],
    };
    await writeFile(
      join(destination, "report.json"),
      JSON.stringify(report, null, 2) + "\n",
      { flag: "wx" },
    );
    return report;
  } catch (error) {
    await Promise.all(Object.values(writers).map((writer) => writer.abort()));
    throw error; // Partial output has no completion report and must never be imported.
  }
}

export const prepareLocalizationPackage = (options) =>
  runPackage(options, false);
export const auditLocalizationPackage = (options) => runPackage(options, true);

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      scan: { type: "string" },
      supplement: { type: "string" },
      ownership: { type: "string" },
      output: { type: "string" },
      input: { type: "string" },
    },
  });
  assert.ok(
    positionals.length === 1 && ["prepare", "audit"].includes(positionals[0]),
    "Use prepare or audit",
  );
  const audit = positionals[0] === "audit";
  assert.ok(
    values.scan && values.supplement &&
      (audit ? values.input && !values.output : values.output && !values.input),
  );
  const result = await runPackage({
    ...values,
    progress: (counts) => console.log(JSON.stringify({ progress: counts })),
  }, audit);
  console.log(
    JSON.stringify(
      {
        status: result.status,
        sourceId: result.sourceId,
        counts: result.counts,
      },
      null,
      2,
    ),
  );
}
