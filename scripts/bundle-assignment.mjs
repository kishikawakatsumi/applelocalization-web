// Conservative on-disk evidence, not Foundation Bundle validation or signature verification.
import { constants } from "node:fs";
import { lstat, open, readdir, readlink } from "node:fs/promises";
import { extname, join } from "node:path";
import { createHash } from "node:crypto";

const version3 = {
  version: 3,
  knownExtensions: [
    ".app",
    ".framework",
    ".bundle",
    ".xpc",
    ".appex",
    ".plugin",
    ".prefPane",
    ".service",
    ".qlgenerator",
    ".mdimporter",
    ".kext",
    ".component",
    ".saver",
    ".systemextension",
    ".axbundle",
    ".action",
  ],
  metadataRequiredExtensions: [".cannedSearch"],
  metadataLocations: [
    "Info.plist",
    "Contents/Info.plist",
    "Resources/Info.plist",
  ],
  maximumMetadataBytes: 2 * 1024 * 1024,
  versionedExtensions: [".framework", ".axbundle", ".bundle"],
  maximumVersions: 64,
  metadataReader: "typed-CFBundleIdentifier-only",
};
// Keep saved v3 evidence reproducible instead of silently changing its meaning.
export const bundlePolicies = {
  3: version3,
  4: {
    ...version3,
    version: 4,
    metadataRequiredExtensions: [".cannedSearch", ".menu", ".assistantBundle"],
  },
};
// Opt-in policy: observed macOS installer containers, each requiring valid
// metadata. Never promote a suffix alone, or change the saved v3/v4 meaning.
bundlePolicies[5] = {
  ...bundlePolicies[4],
  version: 5,
  metadataRequiredExtensions: [
    ...bundlePolicies[4].metadataRequiredExtensions,
    ".sourcebundle",
    ".siriUIBundle",
    ".driver",
    ".definition",
    ".caction",
    ".profileDomainPlugin",
    ".cifilter",
    ".flplugin",
    ".slotd",
    ".ppp",
    ".fs",
    ".loginPlugin",
    ".imservice",
    ".monitorPanel",
    ".monitorPanels",
    ".lpdf",
    ".addresshandler",
    ".brailledriver",
    ".brailletable",
    ".seplugin",
    ".osax",
    ".workflow",
    ".syncschema",
    ".spreporter",
    ".pppreview",
    ".pptheme",
    ".ilmbplugin",
    ".help",
  ],
};
export const bundlePolicy = bundlePolicies[4];
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function assignBundle(
  {
    path,
    imagePath,
    inherited = null,
    device,
    decode,
    onIssue = async () => {},
    policy = bundlePolicy,
  },
) {
  const extension = extname(path),
    known = policy.knownExtensions.includes(extension);
  if (!known && !policy.metadataRequiredExtensions.includes(extension)) {
    return inherited;
  }
  const evidence = {
    version: policy.version,
    bundlePath: imagePath,
    extension,
    metadata: [],
    problems: [],
    aliases: [],
  };
  const problem = async (relative, error, bytes) => {
    const item = {
      imagePath: imagePath + "/" + relative,
      message: error.message,
      code: error.code ?? null,
      ...(bytes ? { sha256: digest(bytes) } : {}),
    };
    evidence.problems.push(item);
    await onIssue(item.imagePath, error);
  };
  const versionPaths = [];
  let safeResourcesAlias = false;
  if (policy.versionedExtensions.includes(extension)) {
    try {
      const versions = join(path, "Versions"), stat = await lstat(versions);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.dev !== device) {
        throw new Error(
          "Versions must be a real directory on the image filesystem",
        );
      }
      const entries = (await readdir(versions)).sort();
      if (entries.length > policy.maximumVersions) {
        throw new Error("Too many framework versions");
      }
      for (const name of entries.filter((n) => n !== "Current")) {
        const s = await lstat(join(versions, name));
        if (!s.isDirectory() || s.isSymbolicLink() || s.dev !== device) {
          throw new Error("Version entries must be real directories");
        }
        versionPaths.push(`Versions/${name}/Resources/Info.plist`);
      }
      try {
        const currentPath = join(versions, "Current"),
          current = await lstat(currentPath);
        if (!current.isSymbolicLink()) {
          throw new Error("Versions/Current must be a relative version alias");
        }
        const target = await readlink(currentPath);
        if (
          !entries.includes(target) || target === "Current" || target === "." ||
          target === ".." || target.includes("/") ||
          !versionPaths.includes(`Versions/${target}/Resources/Info.plist`)
        ) {
          throw new Error(
            "Versions/Current escapes or does not name a real version",
          );
        }
        evidence.aliases.push({
          imagePath: imagePath + "/Versions/Current",
          target,
          followed: false,
        });
        try {
          const aliasPath = join(path, "Resources"),
            alias = await lstat(aliasPath);
          if (alias.isSymbolicLink()) {
            const target = await readlink(aliasPath);
            if (target !== "Versions/Current/Resources") {
              throw new Error("Unsupported Resources alias");
            }
            safeResourcesAlias = true;
            evidence.aliases.push({
              imagePath: imagePath + "/Resources",
              target,
              followed: false,
            });
          }
        } catch (error) {
          if (error.code !== "ENOENT") throw error;
        }
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    } catch (error) {
      if (error.code !== "ENOENT") await problem("Versions", error);
    }
  }
  const locations = [
    ...policy.metadataLocations.filter((p) =>
      !(safeResourcesAlias && p === "Resources/Info.plist")
    ),
    ...versionPaths,
  ];
  for (const relative of locations) {
    let bytes;
    try {
      let current = path;
      const parts = relative.split("/");
      for (let i = 0; i < parts.length; i++) {
        current = join(current, parts[i]);
        const stat = await lstat(current);
        if (
          stat.isSymbolicLink() || stat.dev !== device ||
          (i === parts.length - 1 ? !stat.isFile() : !stat.isDirectory())
        ) {
          throw new Error(
            "Metadata must be a regular file with non-symlink ancestors on the image filesystem",
          );
        }
      }
      const handle = await open(
        current,
        constants.O_RDONLY | constants.O_NOFOLLOW,
      );
      try {
        const stat = await handle.stat();
        if (
          !stat.isFile() || stat.dev !== device ||
          stat.size > policy.maximumMetadataBytes
        ) throw new Error("Invalid metadata file or metadata exceeds 2 MiB");
        bytes = await handle.readFile();
      } finally {
        await handle.close();
      }
      const value = decode(bytes);
      const identifier = value?.CFBundleIdentifier;
      if (
        typeof identifier !== "string" || !/^[A-Za-z0-9_.-]+$/.test(identifier)
      ) throw new Error("Missing or unsupported CFBundleIdentifier");
      evidence.metadata.push({
        imagePath: imagePath + "/" + relative,
        sha256: digest(bytes),
        bytes: bytes.length,
        identifier,
      });
    } catch (error) {
      if (error.code === "ENOENT" && !versionPaths.includes(relative)) continue;
      await problem(relative, error, bytes);
    }
  }
  if (new Set(evidence.metadata.map((m) => m.identifier)).size > 1) {
    const error = new Error("Conflicting CFBundleIdentifier values");
    evidence.problems.push({ imagePath, message: error.message });
    await onIssue(imagePath, error);
  }
  const supported = evidence.metadata.length > 0 &&
    evidence.problems.length === 0;
  if (!known && !supported) {
    if (!evidence.problems.length) {
      await onIssue(
        imagePath,
        new Error(
          "Metadata-required bundle candidate has no usable Info.plist",
        ),
      );
    }
    return inherited;
  }
  return {
    path: imagePath,
    assignment: supported
      ? "nearest-supported-bundle-metadata"
      : evidence.problems.length
      ? "nearest-bundle-boundary-unresolved"
      : "nearest-known-bundle-extension",
    evidence: {
      ...evidence,
      method: supported
        ? "allowlisted-extension-and-info-plist"
        : evidence.problems.length
        ? "unresolved-metadata"
        : "extension-fallback",
    },
  };
}
