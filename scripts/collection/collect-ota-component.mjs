// Full OTA -> the same audited intermediate format as IPSW. No SQL or publication.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { lstat, mkdir, readdir, readFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { boundedCommand } from "./acquire-ipsw-component.mjs";
import { collectionStages } from "./collect-image-localizations.mjs";
import { decodePlist } from "../extraction/extract-mounted-bundle.mjs";
import {
  acquireEncryptedOTA,
  normalizeDecryptedOTA,
  validateEncryptedOTA,
} from "./acquire-encrypted-ota.mjs";
import {
  checkSpace,
  fileHash,
  runCheckpoints,
  scriptCodeHashes,
  withCollectionLock,
  writeJson,
} from "../shared/collection-checkpoints.mjs";

const scripts = fileURLToPath(new URL("./", import.meta.url));
const execute = promisify(execFile);
const json = async (p) => JSON.parse(await readFile(p));
export function validateOTAInput(s) {
  assert.equal(s.formatVersion, 1);
  assert.equal(s.kind, "ota-full");
  assert.ok(["macOS", "iOS"].includes(s.os));
  assert.match(s.version, /^[0-9]+\.[0-9]+(?:\.[0-9]+)?$/);
  assert.match(s.build, /^[0-9]+[A-Z][0-9]+[a-z]?$/);
  assert.ok(
    s.otaVersion === s.version ||
      (s.os === "iOS" && s.otaVersion === `9.9.${s.version}`),
  );
  const url = new URL(s.url);
  assert.equal(url.origin, "https://updates.cdn-apple.com");
  assert.ok(
    url.pathname.endsWith(s.encryptedSource ? ".aea" : ".zip") &&
      !url.username && !url.password &&
      !url.search && !url.hash,
  );
  assert.match(s.archiveSha256, /^[a-f0-9]{64}$/);
  if (s.encryptedSource) {
    validateEncryptedOTA(s.encryptedSource);
    for (const field of ["os", "version", "build", "url"]) {
      assert.equal(
        s[field],
        s.encryptedSource[field],
        "Encrypted source identity mismatch",
      );
    }
    assert.equal(s.maximumDownloadBytes, s.encryptedSource.archiveBytes);
    assert.ok(s.archiveBytes <= s.encryptedSource.maximumDecryptedBytes);
  } else assert.equal(s.archiveBytes, s.maximumDownloadBytes);
  assert.ok(
    Number.isSafeInteger(s.archiveBytes) && s.archiveBytes > 0 &&
      s.archiveBytes <= 20 * 1024 ** 3,
  );
  assert.equal(s.maximumImageBytes, 16 * 1024 ** 3);
  assert.deepEqual(Object.keys(s.metadataHashes).sort(), [
    "AssetData/Info.plist",
    "Info.plist",
  ]);
  Object.values(s.metadataHashes).forEach((h) =>
    assert.match(h, /^[a-f0-9]{64}$/)
  );
  assert.equal(s.stableEvidence.build, s.build);
  const evidence = new URL(s.stableEvidence.url);
  assert.equal(evidence.protocol, "https:");
  assert.ok(
    ["swdist.apple.com", "support.apple.com"].includes(evidence.hostname),
  );
  if (s.component === "regular-payload") {
    assert.equal(s.member, null);
    assert.equal(s.memberBytes, 0);
  } else {
    assert.ok(
      ["cryptex-app", "cryptex-system-arm64e", "cryptex-system-x86_64"]
        .includes(s.component),
    );
    assert.equal(s.member, `AssetData/payloadv2/image_patches/${s.component}`);
    assert.ok(
      Number.isSafeInteger(s.memberBytes) && s.memberBytes > 0 &&
        s.memberBytes <= 6 * 1024 ** 3,
    );
  }
}

export async function collectOTAComponent(
  { spec, output, tool, toolSha256, progress = console.log },
) {
  validateOTAInput(spec);
  assert.equal(process.platform, "darwin");
  await mkdir(output);
  const run = async (command, args) =>
    (await execute(command, args, {
      timeout: 2 * 60 * 60 * 1000,
      maxBuffer: 16 * 1024 ** 2,
    })).stdout;
  const inputPath = join(output, "input.json");
  await writeJson(inputPath, spec);
  const payload = join(output, "payload");
  await mkdir(payload);
  let archive = join(payload, "full-ota.zip");
  progress({ stage: "ota-download", status: "running" });
  if (spec.encryptedSource) {
    const acquired = await acquireEncryptedOTA({
      spec: spec.encryptedSource,
      output: join(output, "encrypted-source"),
      tool,
      toolSha256,
      progress,
    });
    const normalized = await normalizeDecryptedOTA(
      acquired,
      join(output, "normalized"),
    );
    assert.equal(
      normalized.bytes,
      spec.archiveBytes,
      "Normalized ZIP size changed",
    );
    assert.equal(
      normalized.sha256,
      spec.archiveSha256,
      "Normalized ZIP hash changed",
    );
    archive = normalized.path;
  } else {await boundedCommand("/usr/bin/curl", [
      "--fail",
      "--silent",
      "--show-error",
      "--location",
      "--proto",
      "=https",
      "--proto-redir",
      "=https",
      "--max-time",
      "1700",
      "--max-filesize",
      String(spec.archiveBytes),
      "--output",
      archive,
      spec.url,
    ], { directory: payload, maximumBytes: spec.archiveBytes });}
  assert.equal((await lstat(archive)).size, spec.archiveBytes);
  assert.equal(await fileHash(archive), spec.archiveSha256);
  const selected = join(output, "selected");
  await mkdir(selected);
  const metadata = JSON.parse(
    await run("python3", [
      "-B",
      join(scripts, "extract-ota-member.py"),
      "--archive",
      archive,
      "--spec",
      inputPath,
      "--output",
      selected,
    ]),
  );
  assert.equal(metadata.status, "full-ota-metadata-verified");
  await writeJson(join(output, "metadata.json"), metadata);
  progress({ stage: "ota-download", status: "completed" });
  const collection = join(output, "collection");
  const code = await scriptCodeHashes();
  const runCollection = async (root, label, extractionOptions = {}) =>
    withCollectionLock(
      collection,
      () =>
        runCheckpoints({
          output: collection,
          identity: { spec, code },
          progress,
          stages: collectionStages({
            root,
            label,
            minimumFreeBytes: 10 * 1024 ** 3,
            progress,
            extractionOptions,
          }),
        }),
    );
  if (spec.component === "regular-payload") {
    progress({ stage: "ota-projection", status: "running" });
    const projection = join(output, "projection");
    await run("python3", [
      "-B",
      join(scripts, "../extraction/extract-installer-resources.py"),
      "--archive",
      archive,
      "--output",
      projection,
      "--version",
      spec.version,
      "--build",
      spec.build,
      "--ota-version",
      spec.otaVersion,
    ]);
    const runs = await readdir(join(projection, "runs"));
    assert.equal(runs.length, 1);
    const extracted = join(projection, "runs", runs[0]);
    const report = await json(join(extracted, "result.json"));
    assert.equal(report.status, "resource-projection-bom-matched");
    assert.equal(report.identity.archiveSha256, spec.archiveSha256);
    const audit = join(output, "projection-audit.json");
    await run("python3", [
      "-B",
      join(scripts, "../extraction/audit-installer-resources.py"),
      "--run",
      extracted,
      "--output",
      audit,
    ]);
    assert.equal(
      (await json(audit)).status,
      "saved-payloads-and-projection-independently-verified",
    );
    const root = join(extracted, "selected-tree");
    assert.equal(report.tree, root);
    progress({ stage: "ota-projection", status: "completed" });
    await runCollection(
      root,
      `${spec.os}-${spec.version}-${spec.build}-ota-regular-payload-${spec.archiveSha256}`,
      {
        requireReadOnlyMount: false,
        otaProjection: {
          version: spec.version,
          build: spec.build,
          archiveSha256: spec.archiveSha256,
          extractionReportSha256: await fileHash(
            join(extracted, "result.json"),
          ),
          auditSha256: await fileHash(audit),
        },
      },
    );
  } else {
    // Only this job's verified temporary archive is removed. The pinned hash and
    // selected member remain recorded; raw archives are not retention artifacts.
    assert.equal(metadata.path, join(selected, spec.component));
    assert.equal(metadata.bytes, spec.memberBytes);
    await unlink(archive);
    progress({ stage: "ota-raw-archive-released", bytes: spec.archiveBytes });
    const patch = metadata.path, image = patch + ".dmg";
    const patchSha256 = await fileHash(patch);
    await boundedCommand(tool, [
      "ota",
      "patch",
      "rsr",
      "--cryptex",
      patch,
      "--no-color",
    ], {
      directory: selected,
      maximumBytes: spec.memberBytes + spec.maximumImageBytes,
    });
    assert.ok((await lstat(image)).isFile());
    const imageHash = await fileHash(image);
    await writeJson(join(output, "image.json"), {
      patchSha256,
      imageHash,
      archiveSha256: spec.archiveSha256,
    });
    const root = join(output, "mount");
    await mkdir(root);
    let device;
    const mounted = async () =>
      decodePlist(
        Buffer.from(await run("/usr/bin/hdiutil", ["info", "-plist"])),
      ).images ?? [];
    try {
      const attached = decodePlist(
        Buffer.from(
          await run("/usr/bin/hdiutil", [
            "attach",
            image,
            "-readonly",
            "-nobrowse",
            "-noautoopen",
            "-owners",
            "off",
            "-mountpoint",
            root,
            "-plist",
          ]),
        ),
      );
      device = attached["system-entities"].find((e) =>
        /^\/dev\/disk[0-9]+$/.test(e["dev-entry"])
      )?.["dev-entry"];
      assert.ok(device);
      assert.ok(
        (await mounted()).some((i) =>
          i["image-path"] === image &&
          i["system-entities"].some((e) => e["mount-point"] === root)
        ),
      );
      await checkSpace(output, 10 * 1024 ** 3);
      await runCollection(
        root,
        `${spec.os}-${spec.version}-${spec.build}-ota-${spec.component}-${imageHash}`,
      );
    } finally {
      if (device) {
        assert.ok(
          (await mounted()).some((i) =>
            i["image-path"] === image && i["system-entities"].some((e) =>
              e["dev-entry"] === device
            ) && i["system-entities"].some((e) => e["mount-point"] === root)
          ),
        );
        await run("/usr/bin/hdiutil", ["detach", device]);
      }
    }
  }
  return { status: "image-job-package-verified-not-imported", collection };
}
