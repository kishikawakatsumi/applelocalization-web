// Synthetic, cross-platform v1/v2 packages generated through the real scanner.
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import { extractMountedImage } from "../../scripts/extraction/extract-mounted-image.mjs";
import { inspectUnlocalizedResources } from "../../scripts/extraction/inspect-unlocalized-resources.mjs";
import { extractFilenameSupplement } from "../../scripts/extraction/extract-filename-localizations.mjs";
import { prepareLocalizationPackage } from "../../scripts/package/prepare-localization-package.mjs";
import { bundlePolicies } from "../../scripts/package/bundle-assignment.mjs";
import { readJsonLines, sha256 } from "../../scripts/shared/localization-jsonl.mjs";

export async function records(root, name) {
  const result = [];
  for await (const row of readJsonLines(root, name + ".jsonl.gz")) {
    result.push(row);
  }
  return result;
}

export async function ownershipPackageFixture() {
  const temp = await mkdtemp(join(tmpdir(), "ownership-consumers-"));
  const root = join(temp, "image"),
    scan = join(temp, "scan"),
    inspection = join(temp, "inspection"),
    supplement = join(temp, "supplement"),
    ownership = join(temp, "ownership");
  const put = async (path, value) => {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), JSON.stringify(value));
  };
  for (
    const [path, text] of [["Outer.app", "開く"], [
      "Outer.app/Inner.pptheme",
      "開く",
    ], ["Other.pptheme", "営業中"]]
  ) {
    await put(path + "/Contents/Info.plist", {
      CFBundleIdentifier: "fixture." + path.replaceAll("/", "."),
    });
    await put(path + "/Contents/Main.loctable", {
      en: { Open: "Open" },
      ja: { Open: text },
      English: { Open: "Open" },
      Japanese: { Open: text },
    });
  }
  await put("Outer.app/Inner.pptheme/Contents/ja.lproj/Localizable.strings", {
    nul: "a\0b",
    surrogate: "\ud800",
    empty: "",
    ["key\0nul"]: "鍵",
  });
  await put("Outer.app/Inner.pptheme/Contents/ja.lproj/Plural.stringsdict", {
    count: { one: "一つ", other: "%d個", nul: "\0" },
  });
  await put("Outer.app/Unknown.strings", { Unknown: "保留" });
  const siri =
    "System/Library/PrivateFrameworks/SiriTTSService.framework/Versions/A/Resources";
  await put(siri + "/Info.plist", {
    CFBundleIdentifier: "com.apple.siri.SiriTTSService",
  });
  await put(siri + "/LocalizedStrings/Interstitials/ja-JP.strings", {
    Retry: "もう一度",
  });
  const decode = (bytes) => JSON.parse(bytes.toString());
  await extractMountedImage({
    root,
    output: scan,
    label: "synthetic-installer-fixture",
    // This fixture exercises migration of historical v4 ownership to v5.
    bundlePolicyVersion: 4,
    decode,
    requireReadOnlyMount: false,
    minimumFreeBytes: 0,
    installerProjection: {
      version: "15.8.1",
      build: "24H32",
      archiveSha256: "a".repeat(64),
      extractionReportSha256: "b".repeat(64),
      auditSha256: "c".repeat(64),
    },
  });
  await inspectUnlocalizedResources({
    root,
    input: scan,
    output: inspection,
    decode,
  });
  await extractFilenameSupplement({
    root,
    scan,
    inspection,
    output: supplement,
    decode,
    requireReadOnlyMount: false,
  });
  const scanBytes = await readFile(join(scan, "report.json")),
    scanReport = JSON.parse(scanBytes);
  const files = await records(scan, "files"), changes = [], assignments = {};
  for (const file of files) {
    const owner = file.imagePath.startsWith("/Outer.app/Inner.pptheme/")
      ? "/Outer.app/Inner.pptheme"
      : file.imagePath.startsWith("/Other.pptheme/")
      ? "/Other.pptheme"
      : null;
    if (owner) {
      const metadataPath = owner + "/Contents/Info.plist",
        bytes = await readFile(join(root, metadataPath));
      changes.push({
        resourceId: file.resourceId,
        sourceId: file.sourceId,
        imagePath: file.imagePath,
        resourceSha256: file.sha256,
        before: {
          bundlePath: file.bundlePath,
          resourcePath: file.resourcePath,
          assignment: file.bundleAssignment,
        },
        after: {
          bundlePath: owner,
          resourcePath: file.imagePath.slice(owner.length + 1),
          assignment: "nearest-supported-bundle-metadata",
          evidence: {
            version: 5,
            bundlePath: owner,
            extension: ".pptheme",
            method: "allowlisted-extension-and-info-plist",
            problems: [],
            aliases: [],
            metadata: [{
              imagePath: metadataPath,
              sha256: sha256(bytes),
              bytes: bytes.length,
              identifier: JSON.parse(bytes).CFBundleIdentifier,
            }],
          },
        },
        indexedRows: file.status === "parsed" ? file.rows : 0,
      });
    }
    const assignment = owner
      ? "nearest-supported-bundle-metadata"
      : file.bundleAssignment;
    assignments[assignment] = (assignments[assignment] ?? 0) + 1;
  }
  await mkdir(ownership);
  const overlay = gzipSync(
    changes.map((r) => JSON.stringify(r) + "\n").join(""),
  );
  await writeFile(join(ownership, "ownership.jsonl.gz"), overlay);
  await writeFile(
    join(ownership, "report.json"),
    JSON.stringify({
      formatVersion: 1,
      status: "verified-ownership-overlay-not-applied",
      sourceId: scanReport.source.sourceId,
      policy: bundlePolicies[5],
      inputHashes: {
        scanReport: sha256(scanBytes),
        index: sha256(await readFile(join(scan, "files.jsonl.gz"))),
        extraction: scanReport.source.scope.extractionReportSha256,
      },
      counts: {
        files: files.length,
        changedFiles: changes.length,
        previouslyUnbundled: changes.filter((r) =>
          r.before.bundlePath === null
        ).length,
        nestedBoundaryChanges:
          changes.filter((r) => r.before.bundlePath !== null).length,
        affectedRowsFromIndex: changes.reduce((n, r) => n + r.indexedRows, 0),
      },
      assignments,
      overlaySha256: sha256(overlay),
    }),
  );
  const v1 = join(temp, "v1"), v2 = join(temp, "v2");
  const options = { scan, supplement, decode, minimumFreeBytes: 0 };
  await prepareLocalizationPackage({ ...options, output: v1 });
  await prepareLocalizationPackage({ ...options, ownership, output: v2 });
  return { temp, root, v1, v2 };
}
