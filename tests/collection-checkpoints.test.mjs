import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  collectionStages,
  selectImage,
} from "../scripts/collect-image-localizations.mjs";
import {
  runCheckpoints,
  treeHashes,
  withCollectionLock,
} from "../scripts/collection-checkpoints.mjs";

const fresh = () => mkdtemp(join(tmpdir(), "collection-checkpoint-test-"));

test("BuildManifest reader supports Data fields without flattening identity-specific image mappings", async () => {
  const temp = await fresh(), input = join(temp, "BuildManifest.plist");
  await writeFile(
    input,
    `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>ProductVersion</key><string>26.1</string>
<key>ProductBuildVersion</key><string>23B85</string>
<key>SupportedProductTypes</key><array><string>iPhone17,3</string></array>
<key>BuildIdentities</key><array><dict>
<key>Ap,ProductType</key><string>iPhone17,3</string>
<key>Info</key><dict><key>DeviceClass</key><string>d47ap</string><key>Variant</key><string>Customer Erase Install (IPSW)</string><key>Binary</key><data>AQID</data></dict>
<key>Manifest</key><dict>
<key>OS</key><dict><key>Digest</key><data>AQID</data><key>Info</key><dict><key>Path</key><string>normal.dmg.aea</string></dict></dict>
<key>StaticTrustCache</key><dict><key>Info</key><dict><key>Path</key><string>Firmware/normal.dmg.aea.trustcache</string></dict></dict>
</dict></dict></array></dict></plist>`,
  );
  const inventory = JSON.parse(
    execFileSync("python3", ["scripts/inspect-ipsw-manifest.py", input], {
      encoding: "utf8",
    }),
  );
  assert.equal(inventory.identities.length, 1);
  assert.deepEqual(inventory.identities[0].images, { OS: "normal.dmg.aea" });
  assert.equal(inventory.identities[0].board, "d47ap");
  assert.match(inventory.sha256, /^[a-f0-9]{64}$/);
  assert.equal(inventory.version, "26.1");
});
const options = (output, stages, extra = {}) => ({
  output,
  identity: { source: "test", code: "v1" },
  stages,
  minimumFreeBytes: 0,
  ...extra,
});
const stage = (name, value = "original") => ({
  name,
  run: (out) => writeFile(join(out, "value"), value, { flag: "wx" }),
});

test("checkpoint resume verifies all outputs and only runs missing stages", async () => {
  const output = await fresh();
  let calls = 0;
  const stages = [{
    name: "first",
    run: async (out) => {
      calls++;
      await writeFile(join(out, "value"), "same");
    },
  }, stage("last")];
  const run = (extra) =>
    withCollectionLock(
      output,
      () => runCheckpoints(options(output, stages, extra)),
    );
  assert.equal(
    (await run({ through: "first" })).status,
    "collection-checkpoint-reached",
  );
  assert.equal((await run()).status, "collection-package-verified");
  await run();
  assert.equal(calls, 1);
  const receipt = JSON.parse(
    await readFile(join(output, "first.complete.json")),
  );
  await writeFile(join(output, receipt.attempt, "value"), "tampered");
  await assert.rejects(run(), /Completed stage changed/);
});

test("failed attempt is preserved; retry uses a new directory and no completion marker", async () => {
  const output = await fresh();
  let calls = 0;
  const stages = [{
    name: "first",
    run: async (out) => {
      await writeFile(join(out, "value"), "partial");
      if (calls++ === 0) throw Error("simulated failure");
    },
  }];
  const run = () =>
    withCollectionLock(output, () => runCheckpoints(options(output, stages)));
  await assert.rejects(run(), /simulated failure/);
  assert.ok(!(await readdir(output)).includes("first.complete.json"));
  await run();
  assert.equal(
    await readFile(join(output, "first-attempt-0001/value"), "utf8"),
    "partial",
  );
  assert.equal(
    JSON.parse(await readFile(join(output, "first.complete.json"))).attempt,
    "first-attempt-0002",
  );
});

test("input/code drift, nonempty unrelated outputs, symlinks and low space fail closed", async () => {
  const output = await fresh();
  const stages = [stage("first")];
  await withCollectionLock(
    output,
    () => runCheckpoints(options(output, stages)),
  );
  await assert.rejects(
    withCollectionLock(output, () =>
      runCheckpoints(
        options(output, stages, { identity: { source: "changed" } }),
      )),
    /input or collector code changed/,
  );
  const unrelated = await fresh();
  await writeFile(join(unrelated, "user-file"), "keep");
  await assert.rejects(
    withCollectionLock(
      unrelated,
      () => runCheckpoints(options(unrelated, stages)),
    ),
    /unrelated nonempty/,
  );
  const low = await fresh();
  await assert.rejects(
    withCollectionLock(low, () =>
      runCheckpoints(
        options(low, stages, { minimumFreeBytes: Number.MAX_SAFE_INTEGER }),
      )),
    /Insufficient free space/,
  );
  assert.ok(!(await readdir(low)).some((n) => n.includes("attempt")));
  const links = await fresh();
  await symlink(output, join(links, "link"));
  await assert.rejects(treeHashes(links), /Unsupported checkpoint entry/);
});

test("concurrent and stale locks are never stolen", async () => {
  const output = await fresh();
  await withCollectionLock(output, async () => {
    await assert.rejects(withCollectionLock(output, () => {}), {
      code: "EEXIST",
    });
  });
  await mkdir(join(output, ".collection-lock"));
  await assert.rejects(withCollectionLock(output, () => {}), {
    code: "EEXIST",
  });
});

test("manifest selection distinguishes recovery/research/normal OS and records omitted images", () => {
  const digest = "a".repeat(64);
  const spec = {
    formatVersion: 1,
    os: "iOS",
    version: "26.1",
    build: "23B85",
    product: "iPhone17,3",
    board: "d47ap",
    variant: "Customer Erase Install (IPSW)",
    component: "OS",
    imagePath: "normal.dmg.aea",
    url: "https://updates.cdn-apple.com/fixture.ipsw",
    manifest: { path: "/manifest", sha256: digest },
    image: { path: "/image", sha256: digest },
  };
  const inventory = {
    sha256: digest,
    version: spec.version,
    build: spec.build,
    products: [spec.product],
    identities: [
      {
        product: spec.product,
        board: spec.board,
        variant: "Recovery Customer Install",
        images: { OS: "recovery.dmg.aea" },
      },
      {
        product: spec.product,
        board: spec.board,
        variant: spec.variant,
        images: { OS: spec.imagePath, "Cryptex1,SystemOS": "system.dmg.aea" },
      },
    ],
  };
  const selected = selectImage(spec, inventory);
  assert.equal(
    selected.selectedIdentity.images["Cryptex1,SystemOS"],
    "system.dmg.aea",
  );
  assert.match(selected.sourceId, /^iOS-26\.1-23B85-OS-normal-/);
  for (
    const change of [
      { imagePath: "recovery.dmg.aea" },
      { build: "wrong" },
      { board: "wrong" },
      { product: "wrong" },
      { variant: "Research Customer Erase Install (IPSW)" },
      { url: "https://example.com/a.ipsw" },
    ]
  ) {
    assert.throws(() => selectImage({ ...spec, ...change }, inventory));
  }
  assert.throws(
    () =>
      selectImage(spec, {
        ...inventory,
        identities: [...inventory.identities, inventory.identities[1]],
      }),
    /exactly one/,
  );
});

test("real extraction, inspection, supplement and all-language package stages run and resume together", async () => {
  const temp = await fresh(),
    root = join(temp, "image"),
    output = join(temp, "collection");
  for (
    const [language, target] of [["en", "Open"], ["ja", "開く"], [
      "fr",
      "Ouvrir",
    ], ["de", "Öffnen"]]
  ) {
    const directory = join(root, "Demo.app", language + ".lproj");
    await mkdir(directory, { recursive: true });
    await writeFile(
      join(directory, "Localizable.strings"),
      JSON.stringify({ Open: target }),
    );
  }
  await writeFile(
    join(root, "Demo.app", "Unknown.strings"),
    JSON.stringify({ Uncertain: "Do not infer English" }),
  );
  const stages = collectionStages({
    root,
    label: "fixture-source",
    minimumFreeBytes: 0,
    progress: () => {},
    extractionOptions: {
      requireReadOnlyMount: false,
      decode: (bytes) => JSON.parse(bytes.toString()),
    },
  });
  const run = (extra) =>
    withCollectionLock(
      output,
      () => runCheckpoints(options(output, stages, extra)),
    );
  await run({ through: "inspection" });
  const result = await run();
  assert.equal(result.status, "collection-package-verified");
  const report = JSON.parse(
    await readFile(join(result.outputs["package-audit"], "report.json")),
  );
  assert.equal(report.status, "package-content-verified");
  assert.equal(report.counts.occurrences, 4);
  assert.equal(Object.keys((await run()).outputs).length, 7);
});
