import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import process from "node:process";
import {
  boundedCommand,
  manifestLimit,
  solePayload,
  validateAcquisition,
} from "../../scripts/collection/acquire-ipsw-component.mjs";
import { mountedVersionEvidence } from "../../scripts/collection/collect-image-localizations.mjs";

const fresh = () => mkdtemp(join(tmpdir(), "ipsw-acquisition-test-"));

test("manifest byte budget accepts the observed UniversalMac size but remains bounded", async () => {
  const directory = await fresh(),
    file = join(directory, "BuildManifest.plist");
  await writeFile(file, "");
  await truncate(file, 20921870);
  assert.equal(
    (await solePayload(directory, "BuildManifest.plist", manifestLimit)).bytes,
    20921870,
  );
  await truncate(file, manifestLimit + 1);
  await assert.rejects(
    solePayload(directory, "BuildManifest.plist", manifestLimit),
    /budget/,
  );
});
const fixtureSpec = () => ({
  formatVersion: 1,
  os: "iOS",
  version: "26.1",
  build: "23B85",
  product: "iPhone17,3",
  board: "d47ap",
  variant: "Customer Erase Install (IPSW)",
  component: "Cryptex1,AppOS",
  imagePath: "image.dmg",
  url: "https://updates.cdn-apple.com/example.ipsw",
  manifestSha256: "a".repeat(64),
  tool: { path: "/absolute/ipsw", sha256: "b".repeat(64) },
  maximumDownloadBytes: 100,
  maximumImageBytes: 200,
});

test("acquisition requires explicit identity, pinned manifest/tool, Apple HTTPS and bounded sizes", () => {
  const spec = fixtureSpec();
  validateAcquisition(spec);
  for (
    const extra of [
      { maximumImageBytes: 0 },
      { maximumDownloadBytes: -1 },
      { maximumDownloadBytes: 1.5 },
      { maximumImageBytes: Number.MAX_SAFE_INTEGER },
      { manifestSha256: "wrong" },
      { url: "http://updates.cdn-apple.com/a.ipsw" },
      { url: "https://example.com/a.ipsw" },
      { imagePath: "../image.dmg" },
      { variant: "" },
      { tool: { path: "relative", sha256: spec.tool.sha256 } },
    ]
  ) {
    assert.throws(() => validateAcquisition({ ...spec, ...extra }));
  }
});

test("payload selection rejects zero length, unexpected names, extra files, oversize and symlinks", async () => {
  const directory = await fresh();
  await assert.rejects(solePayload(directory, "image.dmg", 10), /exactly one/);
  const file = join(directory, "image.dmg");
  await writeFile(file, "");
  await assert.rejects(solePayload(directory, "image.dmg", 10), /empty/);
  await writeFile(file, "data");
  assert.equal((await solePayload(directory, "image.dmg", 10)).bytes, 4);
  await assert.rejects(solePayload(directory, "wrong.dmg", 10), /Unexpected/);
  await assert.rejects(solePayload(directory, "image.dmg", 3), /budget/);
  await writeFile(join(directory, "extra"), "extra");
  await assert.rejects(solePayload(directory, "image.dmg", 100), /exactly one/);
  const links = await fresh();
  await symlink(file, join(links, "image.dmg"));
  await assert.rejects(solePayload(links, "image.dmg", 10), /Nonregular/);
});

test("bounded command keeps completed small payload; oversize abort preserves partial evidence", async () => {
  const directory = await fresh();
  const file = join(directory, "part");
  await boundedCommand(process.execPath, [
    "-e",
    "require('fs').writeFileSync(process.argv[1], 'small')",
    file,
  ], { directory, maximumBytes: 20, freeReserve: 0, pollMs: 10 });
  assert.equal(await readFile(file, "utf8"), "small");
  await assert.rejects(
    boundedCommand(process.execPath, [
      "-e",
      "require('fs').writeFileSync(process.argv[1], 'x'.repeat(100));setInterval(()=>{},1000)",
      file,
    ], { directory, maximumBytes: 20, freeReserve: 0, pollMs: 10 }),
    /byte budget/,
  );
  assert.equal((await readFile(file)).length, 100);
});

test("nonzero command fails without erasing partial data", async () => {
  const directory = await fresh(), file = join(directory, "part");
  await assert.rejects(
    boundedCommand(process.execPath, [
      "-e",
      "require('fs').writeFileSync(process.argv[1], 'partial');process.exit(2)",
      file,
    ], { directory, maximumBytes: 20, freeReserve: 0, pollMs: 10 }),
  );
  assert.equal(await readFile(file, "utf8"), "partial");
});

test("missing SystemVersion is explicit manifest-only evidence for two Cryptex components, never OS", async () => {
  const root = await fresh();
  for (const component of ["Cryptex1,SystemOS", "Cryptex1,AppOS"]) {
    assert.deepEqual(
      await mountedVersionEvidence(root, { ...fixtureSpec(), component }),
      { kind: "pinned-manifest-component-only", systemVersion: null },
    );
  }
  for (const component of ["OS", "RestoreRamDisk", "Ap,ExclaveOS"]) {
    await assert.rejects(
      mountedVersionEvidence(root, { ...fixtureSpec(), component }),
      { code: "ENOENT" },
    );
  }
  await symlink(await fresh(), join(root, "System"));
  await assert.rejects(mountedVersionEvidence(root, fixtureSpec()));
});

test("Cryptex never hides a malformed or mismatched existing SystemVersion", {
  skip: process.platform !== "darwin",
}, async () => {
  const root = await fresh(),
    directory = join(root, "System/Library/CoreServices");
  await mkdir(directory, { recursive: true });
  const file = join(directory, "SystemVersion.plist");
  const plist = (build) =>
    `<?xml version="1.0"?><plist version="1.0"><dict><key>ProductName</key><string>iPhone OS</string><key>ProductVersion</key><string>26.1</string><key>ProductBuildVersion</key><string>${build}</string></dict></plist>`;
  await writeFile(file, plist("23B85"));
  assert.equal(
    (await mountedVersionEvidence(root, fixtureSpec())).kind,
    "manifest-and-mounted-system-version",
  );
  await writeFile(file, plist("wrong"));
  await assert.rejects(
    mountedVersionEvidence(root, fixtureSpec()),
    /build mismatch/,
  );
  await writeFile(file, "broken");
  await assert.rejects(mountedVersionEvidence(root, fixtureSpec()));
});
