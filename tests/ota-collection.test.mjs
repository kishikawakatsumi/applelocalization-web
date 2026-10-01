import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { validateOTAInput } from "../scripts/collect-ota-component.mjs";
import {
  selectBatchJobs,
  validateBatchPlan,
} from "../scripts/collect-release-batch.mjs";
const batch = JSON.parse(
  await readFile(
    new URL("../scripts/collection-batch-20261002.json", import.meta.url),
  ),
);
test("six full-OTA targets pin exact archives, metadata, stable builds and separate Intel/arm64 components", () => {
  validateBatchPlan(batch);
  const ota = batch.jobs.filter((j) => j.input.kind === "ota-full");
  assert.equal(ota.length, 20);
  ota.forEach((j) => validateOTAInput(j.input));
  assert.equal(
    selectBatchJobs(batch, "macos26,macos15,macos14,macos13,macos12,ios17")
      .include.length,
    20,
  );
  assert.equal(ota.filter((j) => j.target === "macos12").length, 1);
  assert.deepEqual(
    ota.filter((j) => j.target === "ios17").map((j) => j.input.component)
      .sort(),
    ["cryptex-app", "cryptex-system-arm64e", "regular-payload"],
  );
  for (const target of ["macos26", "macos15", "macos14", "macos13"]) {
    assert.equal(ota.filter((j) => j.target === target).length, 4);
  }
});
test("OTA input rejects unknown identity, deltas masquerading as paths, missing hashes and oversized members", () => {
  const s = batch.jobs.find((j) => j.key === "macos15-appos").input;
  for (
    const change of [
      { archiveSha256: null },
      { member: "../escape" },
      { url: "https://example.com/a.zip" },
      { otaVersion: "9.9.15.8.1" },
      { archiveBytes: 1 },
      { memberBytes: 7 * 1024 ** 3 },
      { component: "unknown" },
      { stableEvidence: { url: s.stableEvidence.url, build: "wrong" } },
      { metadataHashes: {} },
    ]
  ) assert.throws(() => validateOTAInput({ ...s, ...change }));
});
test("full OTA metadata reader rejects modified bytes, internal build mismatch and prerequisites before extraction", () => {
  execFileSync("python3", [
    "-B",
    "-c",
    `
import hashlib,importlib.util,json,plistlib,tempfile,zipfile
from pathlib import Path
s=importlib.util.spec_from_file_location('ota','scripts/extract-ota-member.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
with tempfile.TemporaryDirectory() as d:
 p=Path(d); raw=plistlib.dumps({'MobileAssetProperties':{'OSVersion':'9.9.17.7.2','Build':'21H221'}}); info=plistlib.dumps({'ProductVersion':'17.7.2','Build':'21H221'})
 with zipfile.ZipFile(p/'ota.zip','w') as z:
  z.writestr('Info.plist',raw);z.writestr('AssetData/Info.plist',info)
 spec={'metadataHashes':{'Info.plist':hashlib.sha256(raw).hexdigest(),'AssetData/Info.plist':hashlib.sha256(info).hexdigest()},'otaVersion':'9.9.17.7.2','version':'17.7.2','build':'21H221','member':None}
 assert m.extract(p/'ota.zip',spec,p)['status']=='full-ota-metadata-verified'
 for change in [{'build':'wrong'},{'metadataHashes':{**spec['metadataHashes'],'Info.plist':'a'*64}},{'otaVersion':'17.7.2'}]:
  try:m.extract(p/'ota.zip',{**spec,**change},p)
  except ValueError:pass
  else:raise AssertionError(change)
 raw=plistlib.dumps({'MobileAssetProperties':{'OSVersion':'9.9.17.7.2','Build':'21H221','PrerequisiteBuild':'21H216'}})
 with zipfile.ZipFile(p/'delta.zip','w') as z:z.writestr('Info.plist',raw);z.writestr('AssetData/Info.plist',info)
 spec['metadataHashes']['Info.plist']=hashlib.sha256(raw).hexdigest()
 try:m.extract(p/'delta.zip',spec,p)
 except ValueError:pass
 else:raise AssertionError('delta accepted')
`,
  ], { timeout: 30000 });
});
test("candidate chaining is opt-in and stays in the separate non-production workflow", async () => {
  const y = await readFile(
    new URL(
      "../.github/workflows/localization-release-batch.yml",
      import.meta.url,
    ),
    "utf8",
  );
  assert.match(y, /publish_candidates:[\s\S]*?default: false/);
  assert.match(y, /needs: \[plan, collect\]/);
  assert.match(y, /inputs.publish_candidates == true/);
  assert.match(
    y,
    /-f source_run="\$SOURCE_RUN" -f targets=all-ready -f publish=true/,
  );
  assert.doesNotMatch(y, /secrets\.|docker push|gh release|contents: write/);
});
