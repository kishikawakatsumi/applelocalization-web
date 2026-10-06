// Local DMG -> verified all-language package. Does not import or publish to DB.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, realpath, rmdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import process from "node:process";
import { parseArgs, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { decodePlist } from "../extraction/extract-mounted-bundle.mjs";
import { extractMountedImage } from "../extraction/extract-mounted-image.mjs";
import {
  inspectUnlocalizedResources,
  safeRead,
} from "../extraction/inspect-unlocalized-resources.mjs";
import {
  auditFilenameSupplement,
  extractFilenameSupplement,
} from "../extraction/extract-filename-localizations.mjs";
import {
  auditLocalizationPackage,
  prepareLocalizationPackage,
} from "../package/prepare-localization-package.mjs";
import {
  checkSpace,
  fileHash,
  runCheckpoints,
  scriptCodeHashes,
  sha256,
  withCollectionLock,
  writeJson,
} from "../shared/collection-checkpoints.mjs";

const execute = promisify(execFile);
const scripts = dirname(fileURLToPath(import.meta.url));
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const hashPattern = /^[a-f0-9]{64}$/;

export function selectManifestImage(spec, inventory) {
  assert.equal(spec.formatVersion, 1);
  assert.ok(["iOS", "macOS"].includes(spec.os));
  for (
    const key of [
      "version",
      "build",
      "product",
      "board",
      "variant",
      "component",
      "imagePath",
    ]
  ) {
    assert.ok(
      typeof spec[key] === "string" && spec[key].length > 0,
      `Missing ${key}`,
    );
  }
  const url = new URL(spec.url);
  assert.equal(url.protocol, "https:");
  assert.equal(url.hostname, "updates.cdn-apple.com");
  assert.ok(
    !url.username && !url.password && !url.port && !url.hash && !url.search,
  );
  assert.ok(url.pathname.endsWith(".ipsw"));
  for (const key of ["manifest"]) {
    assert.ok(isAbsolute(spec[key].path));
    assert.match(spec[key].sha256, hashPattern);
  }
  assert.equal(
    inventory.sha256,
    spec.manifest.sha256,
    "BuildManifest hash mismatch",
  );
  assert.equal(inventory.version, spec.version);
  assert.equal(inventory.build, spec.build);
  assert.ok(
    inventory.products.includes(spec.product),
    "Product absent from manifest",
  );
  const identities = inventory.identities.filter((i) =>
    i.board === spec.board && i.variant === spec.variant &&
    (i.product === null || i.product === spec.product)
  );
  assert.equal(
    identities.length,
    1,
    "Select exactly one board/product/variant identity",
  );
  assert.equal(
    identities[0].images[spec.component],
    spec.imagePath,
    "Component path mismatch",
  );
  assert.match(spec.imagePath, /^[A-Za-z0-9_-]+\.dmg(?:\.aea)?$/);
  return identities[0];
}

export function selectImage(spec, inventory) {
  const selectedIdentity = selectManifestImage(spec, inventory);
  assert.ok(isAbsolute(spec.image.path));
  assert.match(spec.image.sha256, hashPattern);
  // One component only. Other images are inventoried, never implied collected.
  return {
    selectedIdentity,
    sourceId: `${spec.os}-${spec.version}-${spec.build}-${spec.component}-${
      spec.imagePath.replace(/\.dmg(?:\.aea)?$/, "")
    }-${spec.image.sha256}`,
  };
}

export async function mountedVersionEvidence(root, spec) {
  const cryptex = ["Cryptex1,SystemOS", "Cryptex1,AppOS"].includes(
    spec.component,
  );
  let bytes;
  try {
    bytes = await safeRead(
      root,
      "System/Library/CoreServices/SystemVersion.plist",
    );
  } catch (error) {
    if (!cryptex || error.code !== "ENOENT") throw error;
    return { kind: "pinned-manifest-component-only", systemVersion: null };
  }
  const systemVersion = decodePlist(bytes);
  assert.equal(
    systemVersion.ProductVersion,
    spec.version,
    "Mounted OS version mismatch",
  );
  assert.equal(
    systemVersion.ProductBuildVersion,
    spec.build,
    "Mounted OS build mismatch",
  );
  assert.equal(
    systemVersion.ProductName,
    spec.os === "iOS" ? "iPhone OS" : "macOS",
  );
  return { kind: "manifest-and-mounted-system-version", systemVersion };
}

export function collectionStages(
  { root, label, minimumFreeBytes, progress, extractionOptions = {} },
) {
  const data = (results, key) => join(results[key], "data");
  return [
    {
      name: "scan",
      run: async (out) => {
        const report = await extractMountedImage({
          ...extractionOptions,
          root,
          label,
          minimumFreeBytes,
          progress,
          output: join(out, "data"),
        });
        assert.ok(
          ["scanned-with-issues", "complete-within-scope"].includes(
            report.status,
          ),
        );
      },
    },
    {
      name: "scan-audit",
      run: async (out, r) => {
        await execute(process.execPath, [
          join(scripts, "../extraction/audit-image-extraction.mjs"),
          "--input",
          data(r, "scan"),
          "--output",
          join(out, "report.json"),
        ], { maxBuffer: 8 * 1024 ** 2 });
        assert.equal(
          (await readJson(join(out, "report.json"))).status,
          "output-consistency-verified",
        );
      },
    },
    {
      name: "inspection",
      run: async (out, r) => {
        const report = await inspectUnlocalizedResources({
          root,
          input: data(r, "scan"),
          output: join(out, "data"),
          ...(extractionOptions.decode
            ? { decode: extractionOptions.decode }
            : {}),
        });
        assert.equal(
          report.status,
          "inspected-not-imported",
          "Inspection errors require investigation",
        );
      },
    },
    {
      name: "supplement",
      run: async (out, r) => {
        const report = await extractFilenameSupplement({
          ...extractionOptions,
          root,
          scan: data(r, "scan"),
          inspection: data(r, "inspection"),
          output: join(out, "data"),
        });
        assert.equal(report.status, "extracted-not-imported");
      },
    },
    {
      name: "supplement-audit",
      run: async (out, r) => {
        const report = await auditFilenameSupplement({
          ...extractionOptions,
          root,
          scan: data(r, "scan"),
          inspection: data(r, "inspection"),
          input: data(r, "supplement"),
        });
        assert.equal(report.status, "supplement-content-verified");
        await writeJson(join(out, "report.json"), report);
      },
    },
    {
      name: "package",
      run: async (out, r) => {
        const report = await prepareLocalizationPackage({
          scan: data(r, "scan"),
          supplement: data(r, "supplement"),
          output: join(out, "data"),
          progress,
        });
        assert.equal(report.status, "prepared-not-imported");
      },
    },
    {
      name: "package-audit",
      run: async (out, r) => {
        const report = await auditLocalizationPackage({
          scan: data(r, "scan"),
          supplement: data(r, "supplement"),
          input: data(r, "package"),
          progress,
        });
        assert.equal(report.status, "package-content-verified");
        await writeJson(join(out, "report.json"), report);
      },
    },
  ];
}

async function mountedImages() {
  const info = decodePlist(
    (await execute("/usr/bin/hdiutil", ["info", "-plist"], {
      encoding: "buffer",
      maxBuffer: 8 * 1024 ** 2,
    })).stdout,
  );
  return info.images ?? [];
}

async function verifyMount(root, imagePath) {
  const matching = [];
  for (const image of await mountedImages()) {
    if (
      !(image["system-entities"] ?? []).some((e) => e["mount-point"] === root)
    ) continue;
    assert.equal(
      await realpath(image["image-path"]),
      imagePath,
      "Mounted image does not match pinned DMG",
    );
    matching.push(image);
  }
  assert.equal(matching.length, 1, "Cannot associate mount with pinned DMG");
  const mounts = (await execute("/sbin/mount", [])).stdout.split("\n");
  const line = mounts.find((v) => v.includes(` on ${root} (`));
  assert.ok(
    line &&
      line.split(" (").at(-1).replace(/\)$/, "").split(", ").includes(
        "read-only",
      ),
    "Mount must be read-only",
  );
}

export async function collectImage(
  {
    spec: specPath,
    output,
    root: borrowedRoot,
    through,
    progress = console.log,
  },
) {
  const spec = await readJson(specPath);
  output = resolve(output);
  return await withCollectionLock(output, async () => {
    const inventory = JSON.parse(
      (await execute("python3", [
        join(scripts, "inspect-ipsw-manifest.py"),
        spec.manifest.path,
      ])).stdout,
    );
    const selected = selectImage(spec, inventory);
    progress({ status: "verifying-image-hash" });
    assert.equal(
      await fileHash(spec.image.path),
      spec.image.sha256,
      "DMG hash mismatch",
    );
    const imagePath = await realpath(spec.image.path);
    const code = await scriptCodeHashes();
    const minimumFreeBytes = 10 * 1024 ** 3;
    await checkSpace(output, minimumFreeBytes);
    let root, ownedMount = null, ownedDevice = null;
    try {
      if (borrowedRoot) root = await realpath(borrowedRoot);
      else {
        for (const image of await mountedImages()) {
          if (!image["image-path"]) continue;
          assert.notEqual(
            await realpath(image["image-path"]),
            imagePath,
            "Image is already attached; explicitly borrow it with --root",
          );
        }
        ownedMount = await mkdtemp(join(dirname(output), ".collection-mount-"));
        root = ownedMount;
        const result = await execute("/usr/bin/hdiutil", [
          "attach",
          imagePath,
          "-readonly",
          "-nobrowse",
          "-noautoopen",
          "-owners",
          "off",
          "-mountpoint",
          root,
          "-plist",
        ], { encoding: "buffer", maxBuffer: 8 * 1024 ** 2 });
        const entities = decodePlist(result.stdout)["system-entities"];
        ownedDevice = entities?.find((e) =>
          /^\/dev\/disk[0-9]+$/.test(e["dev-entry"])
        )?.["dev-entry"];
        assert.ok(
          ownedDevice,
          "No owned device handle returned; inspect hdiutil info before manual cleanup",
        );
      }
      await verifyMount(root, imagePath);
      const versionEvidence = await mountedVersionEvidence(root, spec);
      assert.ok(
        output !== root && !output.startsWith(root + "/"),
        "Output inside input mount",
      );
      const identity = {
        spec,
        inventory,
        ...selected,
        systemVersion: versionEvidence.systemVersion,
        versionEvidence,
        collectorSha256: sha256(JSON.stringify(code)),
      };
      return await runCheckpoints({
        output,
        identity,
        through,
        minimumFreeBytes,
        progress,
        stages: collectionStages({
          root,
          label: selected.sourceId,
          minimumFreeBytes,
          progress,
        }),
      });
    } finally {
      // Never detach a mount borrowed with --root, including the old macOS mount.
      if (ownedDevice) {
        await execute("/usr/bin/hdiutil", ["detach", ownedDevice]);
        await rmdir(ownedMount);
      } else if (ownedMount) {
        // Attach may have partially succeeded: retain path, report for inspection.
        progress({
          status: "mount-cleanup-needs-inspection",
          path: ownedMount,
        });
      }
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      spec: { type: "string" },
      output: { type: "string" },
      root: { type: "string" },
      through: { type: "string" },
    },
  });
  assert.ok(values.spec && values.output, "--spec and --output are required");
  console.log(
    JSON.stringify(
      await collectImage({
        ...values,
        progress: (value) => console.log(JSON.stringify(value)),
      }),
      null,
      2,
    ),
  );
}
