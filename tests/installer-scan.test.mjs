import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { gunzipSync } from "node:zlib";
import { inspectUnlocalizedResources } from "../scripts/inspect-unlocalized-resources.mjs";
import { extractFilenameSupplement } from "../scripts/extract-filename-localizations.mjs";
import {
  auditLocalizationPackage,
  prepareLocalizationPackage,
} from "../scripts/prepare-localization-package.mjs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";

test("original-value comparison distinguishes JSON booleans and numbers", () => {
  execFileSync("python3", [
    "-B",
    "-c",
    `
import importlib.util
s=importlib.util.spec_from_file_location("audit", "scripts/audit-installer-scan.py")
m=importlib.util.module_from_spec(s); s.loader.exec_module(m)
assert m.same_json({"a":[1,True]}, {"a":[1.0,True]})
assert not m.same_json({"a":[1,True]}, {"a":[True,1]})
assert not m.same_json("1",1)
`,
  ]);
});

test(
  "installer scan round trip preserves every language, audits originals and quarantines ambiguity",
  { skip: process.platform !== "darwin" },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "installer-scan-test-"));
    try {
      const output = execFileSync("python3", [
        "-B",
        "-c",
        `
import pathlib, plistlib, subprocess, zipfile, importlib.util, sys
base=pathlib.Path(sys.argv[1])
spec=importlib.util.spec_from_file_location("extract", "scripts/extract-installer-resources.py")
m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)
root=base / "files"; root.mkdir()
data={
 m.sample.SYSTEM_VERSION:plistlib.dumps({"ProductVersion":"15.8.1","ProductBuildVersion":"24H32"}),
 "Test.app/Contents/Info.plist":plistlib.dumps({"CFBundleIdentifier":"test.bundle"}),
 "Test.app/Contents/Resources/Table.loctable":plistlib.dumps({"en":{"Open":"Open"},"ja":{"Open":"開く"},"zz":{"Open":"Other"}}),
 "Test.app/Contents/Resources/ja.lproj/Localizable.strings":b'"Open" = "Open legacy";',
 "Test.app/Contents/Resources/fr.lproj/Plural.stringsdict":plistlib.dumps({"n":{"one":"un","other":"plusieurs"}}),
 "Test.app/Contents/Resources/Unknown.strings":plistlib.dumps({"Key":"Do not guess"}),
 "Test.app/Contents/Inner.pptheme/Contents/Info.plist":plistlib.dumps({"CFBundleIdentifier":"test.inner"}),
 "Test.app/Contents/Inner.pptheme/Contents/Resources/ja.lproj/Theme.strings":plistlib.dumps({"Key":"Theme"}),
 "System/Library/PrivateFrameworks/SiriTTSService.framework/Versions/A/Resources/Info.plist":plistlib.dumps({"CFBundleIdentifier":"com.apple.siri.SiriTTSService"}),
 "System/Library/PrivateFrameworks/SiriTTSService.framework/Versions/A/Resources/LocalizedStrings/Interstitials/ja-JP.strings":plistlib.dumps({"Retry":"もう一度"}),
}
for path,value in data.items():
 p=root/path; p.parent.mkdir(parents=True,exist_ok=True); p.write_bytes(value)
subprocess.run(["/usr/bin/mkbom",str(root),str(base/"post.bom")],check=True)
subprocess.run(["/usr/bin/aa","archive","-d",str(root),"-o",str(base/"payload.000")],check=True)
with zipfile.ZipFile(base/"input.zip","w") as z:
 z.writestr("Info.plist",plistlib.dumps({"MobileAssetProperties":{"OSVersion":"15.8.1","Build":"24H32"}}))
 z.writestr("AssetData/Info.plist",plistlib.dumps({"ProductVersion":"15.8.1","Build":"24H32"}))
 z.writestr("AssetData/payloadv2/links.txt","")
 z.write(base/"post.bom","AssetData/post.bom")
 z.write(base/"payload.000","AssetData/payloadv2/payload.000")
result=m.extract(base/"input.zip",base/"extraction","15.8.1","24H32")
print(pathlib.Path(result["tree"]).parent)
`,
        temp,
      ], { encoding: "utf8", timeout: 60000 });
      const run = output.trim().split("\n").at(-1);
      const scan = join(temp, "parsed");
      execFileSync(process.execPath, [
        "scripts/scan-installer-resources.mjs",
        "--run",
        run,
        "--output",
        scan,
      ], { timeout: 60000 });
      const result = JSON.parse(await readFile(join(scan, "result.json")));
      assert.equal(result.status, "installer-projection-parsed-and-audited");
      assert.equal(result.scanStatus, "scanned-with-issues");
      assert.equal(result.counts.rows, 6);
      assert.equal(result.counts.failedFiles, 2);
      assert.equal(result.counts.quarantinedFiles, 2);
      assert.deepEqual(result.languageCodes, ["en", "fr", "ja", "zz"]);
      const audit = JSON.parse(
        await readFile(join(scan, "originals-audit.json")),
      );
      assert.equal(audit.decoders.plutilXmlFallback, 1);
      assert.equal(audit.counts.structuredRows, 1);
      assert.equal(
        audit.failureCategories["language-not-uniquely-determined"],
        2,
      );
      assert.equal(audit.verifiedBundleMetadataFiles, 3);
      const scanReport = JSON.parse(await readFile(join(scan, "scan/report.json")));
      assert.equal(scanReport.bundlePolicy.version, 6);
      const inspection = join(temp, "inspection"),
        supplement = join(temp, "supplement");
      const root = join(run, "selected-tree"), primaryScan = join(scan, "scan");
      await inspectUnlocalizedResources({
        root,
        input: primaryScan,
        output: inspection,
      });
      await extractFilenameSupplement({
        root,
        scan: primaryScan,
        inspection,
        output: supplement,
        requireReadOnlyMount: false,
      });
      const options = { scan: primaryScan, supplement, minimumFreeBytes: 0 };
      const outputPackage = join(temp, "package");
      const pkg = await prepareLocalizationPackage({
        ...options,
        output: outputPackage,
      });
      assert.equal(pkg.formatVersion, 1);
      assert.equal(pkg.counts.occurrences, 7);
      assert.equal(pkg.counts.supplementRows, 1);
      assert.equal(pkg.counts.unresolvedFiles, 1);
      const stream = async (directory, name) =>
        gunzipSync(await readFile(join(directory, name + ".jsonl.gz")))
          .toString().trim().split("\n").map(JSON.parse);
      const resources = await stream(outputPackage, "resources");
      const nested = resources.find((r) => r.original.imagePath.endsWith("/Theme.strings"));
      assert.equal(nested.original.bundlePath, "/Test.app/Contents/Inner.pptheme");
      assert.equal(nested.original.tablePath, "Contents/Resources/Theme.strings");
      assert.equal(nested.original.bundleEvidence.metadata[0].identifier, "test.inner");
      assert.ok(resources.every((r) => !r.ownershipCorrection));
      assert.equal(
        resources.find((r) => r.status === "supplemented-inferred").supplement
          .languageEvidence.languageStatus,
        "inferred",
      );
      const table = (await stream(outputPackage, "tables")).find((t) =>
        t.tableId === nested.tableId
      );
      assert.equal(table.bundlePath, nested.original.bundlePath);
      const verified = await auditLocalizationPackage({
        ...options,
        input: outputPackage,
      });
      assert.equal(verified.status, "package-content-verified");
      const currentFiles = await stream(primaryScan, "files");
      assert.equal(
        currentFiles.find((f) => f.imagePath.endsWith("/Theme.strings"))
          .bundlePath,
        "/Test.app/Contents/Inner.pptheme",
      );
      const originalPath = join(
        run,
        "selected-tree/Test.app/Contents/Inner.pptheme/Contents/Resources/ja.lproj/Theme.strings",
      );
      const originalBytes = await readFile(originalPath);
      await writeFile(originalPath, "corrupt");
      const changedOriginal = spawnSync("python3", [
        "-B", "scripts/audit-installer-scan.py", "--run", run,
        "--scan", primaryScan, "--output", join(scan, "bad-original.json"),
      ], { encoding: "utf8" });
      assert.notEqual(changedOriginal.status, 0);
      await writeFile(originalPath, originalBytes);
      // Modify a row but leave totals unchanged: original-value audit must fail.
      execFileSync("python3", [
        "-c",
        `
import gzip,json,sys,pathlib
p=pathlib.Path(sys.argv[1])
with gzip.open(p,"rb") as f: rows=[json.loads(line) for line in f]
rows[0]["target"]="corrupt"
with gzip.open(p,"wb") as f:
 for row in rows: f.write((json.dumps(row)+"\\n").encode())
`,
        join(scan, "scan/rows.jsonl.gz"),
      ]);
      const bad = spawnSync("python3", [
        "-B",
        "scripts/audit-installer-scan.py",
        "--run",
        run,
        "--scan",
        join(scan, "scan"),
        "--output",
        join(scan, "bad.json"),
      ], { encoding: "utf8" });
      assert.notEqual(bad.status, 0);
      assert.match(bad.stderr, /Original value mismatch/);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  },
);
