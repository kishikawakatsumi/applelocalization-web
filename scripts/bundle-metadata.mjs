import { spawnSync } from "node:child_process";

// Extract only a typed identifier. Unrelated plist data/date values must not
// make a valid bundle look invalid; do not JSON-convert the entire dictionary.
export function readBundleMetadata(bytes) {
  const run = (args) => {
    const result = spawnSync("/usr/bin/plutil", args, {
      input: bytes,
      encoding: "utf8",
      timeout: 10000,
      maxBuffer: 64 * 1024,
    });
    if (result.error) throw result.error;
    if (result.status !== 0) {
      throw new Error(
        `Bundle metadata: ${
          (result.stderr || result.stdout || `plutil exit ${result.status}`)
            .trim()
        }`,
      );
    }
    return result.stdout;
  };
  run(["-lint", "--", "-"]);
  const identifier = run([
    "-extract",
    "CFBundleIdentifier",
    "raw",
    "-expect",
    "string",
    "-n",
    "-o",
    "-",
    "--",
    "-",
  ]);
  return { CFBundleIdentifier: identifier };
}
