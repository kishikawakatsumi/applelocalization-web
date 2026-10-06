import test from "node:test";
import assert from "node:assert/strict";
import { lstat, mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import {
  assignBundle,
  bundlePolicies,
  bundlePolicy,
} from "../../scripts/package/bundle-assignment.mjs";
import { readBundleMetadata } from "../../scripts/package/bundle-metadata.mjs";

async function fixture() {
  const temp = await mkdtemp(join(tmpdir(), "bundle-policy-")),
    path = join(temp, "Example.framework");
  await mkdir(path);
  const put = async (relative, value) => {
    await mkdir(join(path, relative, ".."), { recursive: true });
    await writeFile(
      join(path, relative),
      typeof value === "string" ? value : JSON.stringify(value),
    );
  };
  const issues = [];
  const options = {
    path,
    imagePath: "/Example.framework",
    device: (await lstat(path)).dev,
    decode: (bytes) => JSON.parse(bytes),
    onIssue: async (path, error) => issues.push({ path, error: error.message }),
  };
  const version = async (name, id) =>
    put(`Versions/${name}/Resources/Info.plist`, { CFBundleIdentifier: id });
  const aliases = async (target = "A") => {
    await symlink(target, join(path, "Versions/Current"));
    await symlink("Versions/Current/Resources", join(path, "Resources"));
  };
  return { temp, path, put, options, issues, version, aliases };
}

for (
  const extension of bundlePolicies[5].metadataRequiredExtensions.filter(
    (ext) => !bundlePolicies[4].metadataRequiredExtensions.includes(ext),
  )
) {
  test(`v5 ${extension} requires metadata and leaves v4 unchanged`, async () => {
    const f = await fixture();
    await f.put("Info.plist", { CFBundleIdentifier: "com.parent" });
    const inherited = await assignBundle(f.options);
    const relative = "Contents/Inner" + extension;
    await f.put(relative + "/Contents/Info.plist", {
      CFBundleIdentifier: "com.inner",
    });
    const options = {
      ...f.options,
      path: join(f.path, relative),
      imagePath: "/Example.framework/" + relative,
      inherited,
    };
    assert.strictEqual(await assignBundle(options), inherited);
    const result = await assignBundle({
      ...options,
      policy: bundlePolicies[5],
    });
    assert.equal(result.path, options.imagePath);
    assert.equal(result.assignment, "nearest-supported-bundle-metadata");
    assert.equal(result.evidence.version, 5);
    assert.equal(result.evidence.metadata[0].identifier, "com.inner");
    await f.put(relative + "/Info.plist", {
      CFBundleIdentifier: "com.conflict",
    });
    assert.strictEqual(
      await assignBundle({ ...options, policy: bundlePolicies[5] }),
      inherited,
    );
    await f.put(relative + "/Info.plist", {});
    assert.strictEqual(
      await assignBundle({ ...options, policy: bundlePolicies[5] }),
      inherited,
    );
    const empty = join(f.path, "Empty" + extension);
    await mkdir(empty);
    assert.equal(
      await assignBundle({
        ...options,
        path: empty,
        imagePath: "/Empty" + extension,
        inherited: null,
        policy: bundlePolicies[5],
      }),
      null,
    );
  });
}

test("v5 does not promote arbitrary directories, localized folders or color collections", async () => {
  const f = await fixture();
  for (
    const name of ["Resources", "ja.lproj", "Apple.clr", "Unknown.unknown"]
  ) {
    await f.put(name + "/Info.plist", { CFBundleIdentifier: "not.enough" });
    assert.equal(
      await assignBundle({
        ...f.options,
        path: join(f.path, name),
        imagePath: "/" + name,
        policy: bundlePolicies[5],
      }),
      null,
    );
  }
  assert.equal(bundlePolicy.version, 4);
});

for (const extension of [".menu", ".assistantBundle"]) {
  test(`${extension} requires metadata and respects nested ownership without changing v3`, async () => {
    const f = await fixture();
    await f.put("Info.plist", { CFBundleIdentifier: "com.parent" });
    const parent = await assignBundle(f.options);
    const relative = "Contents/Plugins/Inner" + extension;
    await f.put(relative + "/Contents/Info.plist", {
      CFBundleIdentifier: "com.inner",
    });
    const options = {
      ...f.options,
      path: join(f.path, relative),
      imagePath: "/Example.framework/" + relative,
      inherited: parent,
    };
    const inner = await assignBundle(options);
    assert.equal(inner.path, options.imagePath);
    assert.equal(inner.evidence.version, 4);
    assert.equal(inner.assignment, "nearest-supported-bundle-metadata");
    assert.equal(inner.evidence.metadata[0].identifier, "com.inner");
    assert.strictEqual(
      await assignBundle({ ...options, policy: bundlePolicies[3] }),
      parent,
    );
    await f.put(relative + "/Child.bundle/Info.plist", {
      CFBundleIdentifier: "com.child",
    });
    const child = await assignBundle({
      ...options,
      path: join(options.path, "Child.bundle"),
      imagePath: options.imagePath + "/Child.bundle",
      inherited: inner,
    });
    assert.equal(child.evidence.metadata[0].identifier, "com.child");
    assert.equal(child.path, options.imagePath + "/Child.bundle");
    // A suffix match alone must never introduce a new confirmed owner.
    const missing = join(f.path, "Empty" + extension);
    await mkdir(missing);
    assert.equal(
      await assignBundle({
        ...options,
        path: missing,
        imagePath: "/Empty" + extension,
        inherited: null,
      }),
      null,
    );
    assert.strictEqual(
      await assignBundle({ ...options, path: missing }),
      parent,
    );
    assert.ok(f.issues.some((i) => i.error.includes("no usable Info.plist")));
  });

  test(`${extension} rejects malformed, conflicting and symlinked metadata`, async () => {
    for (
      const mode of [
        "missing-id",
        "wrong-type",
        "invalid-id",
        "broken",
        "conflict",
        "file-link",
        "directory-link",
      ]
    ) {
      const f = await fixture(), relative = "Inner" + extension;
      const path = join(f.path, relative);
      const id = { CFBundleIdentifier: "com.inner" };
      if (mode === "file-link") {
        await f.put("outside.plist", id);
        await mkdir(join(path, "Contents"), { recursive: true });
        await symlink(
          join(f.path, "outside.plist"),
          join(path, "Contents/Info.plist"),
        );
      } else if (mode === "directory-link") {
        await f.put("outside/Info.plist", id);
        await mkdir(path);
        await symlink(join(f.path, "outside"), join(path, "Contents"));
      } else {
        await f.put(
          relative + "/Contents/Info.plist",
          mode === "missing-id"
            ? {}
            : mode === "wrong-type"
            ? { CFBundleIdentifier: 12 }
            : mode === "invalid-id"
            ? { CFBundleIdentifier: "com.bad id" }
            : mode === "broken"
            ? "invalid JSON"
            : id,
        );
        if (mode === "conflict") {
          await f.put(relative + "/Info.plist", {
            CFBundleIdentifier: "com.other",
          });
        }
      }
      const result = await assignBundle({
        ...f.options,
        path,
        imagePath: "/" + relative,
      });
      assert.equal(result, null, mode);
      assert.ok(f.issues.length > 0, mode);
    }
  });
}
test("versioned bundles use real paths and record but do not traverse conventional aliases", async () => {
  const f = await fixture();
  await f.version("A", "com.example");
  await f.aliases();
  const result = await assignBundle(f.options);
  assert.equal(result.assignment, "nearest-supported-bundle-metadata");
  assert.equal(
    result.evidence.metadata[0].imagePath,
    "/Example.framework/Versions/A/Resources/Info.plist",
  );
  assert.equal(result.evidence.aliases.length, 2);
  assert.ok(result.evidence.aliases.every((a) => a.followed === false));
  assert.equal(f.issues.length, 0);
});
test("all real versions must agree; Current does not hide conflicts or missing metadata", async () => {
  const f = await fixture();
  await f.version("A", "com.first");
  await f.version("B", "com.second");
  await f.aliases();
  const result = await assignBundle(f.options);
  assert.equal(result.path, "/Example.framework");
  assert.equal(result.assignment, "nearest-bundle-boundary-unresolved");
  assert.equal(result.evidence.metadata.length, 2);
  assert.ok(f.issues.some((i) => i.error.includes("Conflicting")));
  const g = await fixture();
  await g.version("A", "com.first");
  await mkdir(join(g.path, "Versions/B"));
  const missing = await assignBundle(g.options);
  assert.equal(missing.assignment, "nearest-bundle-boundary-unresolved");
  assert.ok(g.issues.some((i) => i.path.includes("/Versions/B/")));
});
test("matching versions without Current remain scoped to one boundary with all evidence", async () => {
  const f = await fixture();
  await f.version("A", "com.same");
  await f.version("B", "com.same");
  const result = await assignBundle(f.options);
  assert.equal(result.assignment, "nearest-supported-bundle-metadata");
  assert.equal(result.evidence.metadata.length, 2);
});
test("escaping aliases, symlinked versions and symlinked metadata cannot supply evidence", async () => {
  const f = await fixture();
  await f.version("A", "com.safe");
  await f.aliases("../../outside");
  assert.equal(
    (await assignBundle(f.options)).assignment,
    "nearest-bundle-boundary-unresolved",
  );
  assert.ok(f.issues.some((i) => i.error.includes("escapes")));
  const g = await fixture();
  await g.version("A", "com.safe");
  await symlink(g.temp, join(g.path, "Versions/B"));
  assert.equal(
    (await assignBundle(g.options)).assignment,
    "nearest-bundle-boundary-unresolved",
  );
  const h = await fixture();
  await mkdir(join(h.path, "Versions/A/Resources"), { recursive: true });
  await writeFile(
    join(h.temp, "outside"),
    JSON.stringify({ CFBundleIdentifier: "com.outside" }),
  );
  await symlink(
    join(h.temp, "outside"),
    join(h.path, "Versions/A/Resources/Info.plist"),
  );
  const result = await assignBundle(h.options);
  assert.equal(result.evidence.metadata.length, 0);
  assert.equal(result.assignment, "nearest-bundle-boundary-unresolved");
});
test("bounded metadata accepts the observed size range but refuses larger files and version explosions", async () => {
  const f = await fixture();
  await f.put(
    "Info.plist",
    JSON.stringify({
      CFBundleIdentifier: "com.large",
      padding: "x".repeat(1400000),
    }),
  );
  assert.equal(
    (await assignBundle(f.options)).assignment,
    "nearest-supported-bundle-metadata",
  );
  await f.put("Info.plist", "x".repeat(bundlePolicy.maximumMetadataBytes + 1));
  const tooLarge = await assignBundle(f.options);
  assert.equal(tooLarge.evidence.metadata.length, 0);
  assert.ok(f.issues.some((i) => i.error.includes("2 MiB")));
  const g = await fixture();
  for (let i = 0; i < 65; i++) {
    await mkdir(join(g.path, "Versions", String(i)), { recursive: true });
  }
  assert.equal(
    (await assignBundle(g.options)).assignment,
    "nearest-bundle-boundary-unresolved",
  );
});
test(
  "typed identifier extraction supports XML and binary plists with unrelated data/date fields",
  { skip: process.platform !== "darwin" },
  () => {
    const xml = Buffer.from(
      '<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.example.typed</string><key>blob</key><data>AQID</data><key>date</key><date>2025-01-01T00:00:00Z</date></dict></plist>',
    );
    assert.deepEqual(readBundleMetadata(xml), {
      CFBundleIdentifier: "com.example.typed",
    });
    const binary = spawnSync("/usr/bin/plutil", [
      "-convert",
      "binary1",
      "-o",
      "-",
      "--",
      "-",
    ], { input: xml });
    assert.equal(binary.status, 0);
    assert.deepEqual(readBundleMetadata(binary.stdout), {
      CFBundleIdentifier: "com.example.typed",
    });
    assert.throws(() => readBundleMetadata(Buffer.from("broken")));
    assert.throws(() =>
      readBundleMetadata(Buffer.from('{"CFBundleIdentifier":12}'))
    );
    assert.throws(() =>
      readBundleMetadata(Buffer.from('{"unrelated":"field"}'))
    );
  },
);
