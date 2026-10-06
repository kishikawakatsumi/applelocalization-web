import test from "node:test";
import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gunzipSync } from "node:zlib";
import {
  assignBundle,
  bundlePolicies,
  bundlePolicy,
  currentBundlePolicy,
} from "../../scripts/package/bundle-assignment.mjs";
import { extractMountedImage } from "../../scripts/extraction/extract-mounted-image.mjs";
import { verifyReassignment } from "../../scripts/package/verify-bundle-reassignment.mjs";

const lines = async (p) =>
  gunzipSync(await readFile(p)).toString().trim().split("\n").filter(Boolean)
    .map(JSON.parse);
for (
  const ext of currentBundlePolicy.metadataRequiredExtensions.filter((e) =>
    !bundlePolicies[5].metadataRequiredExtensions.includes(e)
  )
) {
  test(`v6 ${ext} needs non-conflicting original metadata; v4 and v5 stay unchanged`, async () => {
    const root = await mkdtemp(join(tmpdir(), "bundle-v6-")),
      path = join(root, "Example" + ext);
    await mkdir(path);
    const inherited = { path: "/Parent.app" },
      options = {
        path,
        imagePath: "/Parent.app/Example" + ext,
        device: (await lstat(path)).dev,
        decode: JSON.parse,
        inherited,
      };
    assert.equal(
      await assignBundle({ ...options, policy: currentBundlePolicy }),
      inherited,
    );
    await writeFile(
      join(path, "Info.plist"),
      JSON.stringify({ CFBundleIdentifier: "com.example.child" }),
    );
    const next = await assignBundle({
      ...options,
      policy: currentBundlePolicy,
    });
    assert.equal(next.path, options.imagePath);
    assert.equal(next.assignment, "nearest-supported-bundle-metadata");
    assert.equal(next.evidence.version, 6);
    for (const version of [4, 5]) {
      assert.equal(
        await assignBundle({ ...options, policy: bundlePolicies[version] }),
        inherited,
      );
    }
    await mkdir(join(path, "Contents"));
    await writeFile(
      join(path, "Contents", "Info.plist"),
      JSON.stringify({ CFBundleIdentifier: "com.example.conflict" }),
    );
    assert.equal(
      await assignBundle({ ...options, policy: currentBundlePolicy }),
      inherited,
    );
  });
}

test("default v6 scan changes only verified ownership; nested ordinary bundles and missing metadata stay safe", async () => {
  const temp = await mkdtemp(join(tmpdir(), "bundle-v6-scan-")),
    root = join(temp, "image");
  await mkdir(root);
  const put = async (p, v) => {
    await mkdir(join(root, p, ".."), { recursive: true });
    await writeFile(join(root, p), JSON.stringify(v));
  };
  await put("System/Health/Sample.healthplugin/Info.plist", {
    CFBundleIdentifier: "com.health",
  });
  await put("System/Health/Sample.healthplugin/ja.lproj/A.strings", {
    Open: "開く",
  });
  await put("System/Health/Sample.healthplugin/Child.bundle/Info.plist", {
    CFBundleIdentifier: "com.child",
  });
  await put(
    "System/Health/Sample.healthplugin/Child.bundle/ja.lproj/A.strings",
    { Open: "別の訳" },
  );
  await put("System/Other/Missing.healthplugin/ja.lproj/A.strings", {
    Open: "未確定",
  });
  await put("System/Other/Fake.manifest/Info.plist", {
    CFBundleIdentifier: "com.not.a.bundle",
  });
  await put("System/Other/Fake.manifest/ja.lproj/A.strings", {
    Open: "元の文脈",
  });
  await put("System/Profiler/SPTest.spreporter/Contents/Info.plist", {
    CFBundleIdentifier: "com.profiler",
  });
  await put(
    "System/Profiler/SPTest.spreporter/Contents/Resources/ja.lproj/A.strings",
    { Open: "レポート" },
  );
  await mkdir(join(root, "System/Linked.healthplugin"));
  await symlink(
    join(root, "System/Health/Sample.healthplugin/Info.plist"),
    join(root, "System/Linked.healthplugin/Info.plist"),
  );
  await put("System/Linked.healthplugin/ja.lproj/A.strings", {
    Open: "リンク",
  });
  const base = {
    root,
    label: "v6-fixture",
    decode: JSON.parse,
    requireReadOnlyMount: false,
    minimumFreeBytes: 0,
  };
  const baseline = join(temp, "before"), candidate = join(temp, "after");
  const before = await extractMountedImage({
    ...base,
    output: baseline,
    bundlePolicyVersion: 4,
  });
  const after = await extractMountedImage({ ...base, output: candidate });
  assert.equal(bundlePolicy.version, 4);
  assert.equal(before.bundlePolicy.version, 4);
  assert.equal(after.bundlePolicy.version, 6);
  const result = await verifyReassignment({ baseline, candidate, root });
  assert.equal(result.counts.rows, 6);
  assert.equal(result.counts.changedBundleResources, 2);
  const files = await lines(join(candidate, "files.jsonl.gz"));
  assert.equal(
    files.find((f) => f.imagePath.includes("/Child.bundle/")).bundlePath,
    "/System/Health/Sample.healthplugin/Child.bundle",
  );
  for (
    const part of [
      "/Missing.healthplugin/",
      "/Fake.manifest/",
      "/Linked.healthplugin/",
    ]
  ) {
    assert.equal(
      files.find((f) => f.imagePath.includes(part)).bundlePath,
      null,
    );
  }
  await assert.rejects(
    extractMountedImage({
      ...base,
      output: join(temp, "invalid"),
      bundlePolicyVersion: 99,
    }),
    /Unsupported bundle policy/,
  );
  const reportPath = join(candidate, "report.json");
  const tampered = JSON.parse(await readFile(reportPath));
  tampered.bundlePolicy.metadataRequiredExtensions.push(".manifest");
  await writeFile(reportPath, JSON.stringify(tampered));
  await assert.rejects(verifyReassignment({ baseline, candidate, root }));
});
