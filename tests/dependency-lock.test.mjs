import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("npm and Deno lockfiles track the package manifest dependencies", async () => {
  const [pkg, npmLock, denoLock] = await Promise.all(
    ["package.json", "package-lock.json", "deno.lock"].map(async (path) =>
      JSON.parse(await readFile(new URL("../" + path, import.meta.url), "utf8"))),
  );
  for (const kind of ["dependencies", "devDependencies"]) {
    assert.deepEqual(npmLock.packages[""][kind], pkg[kind], `npm ${kind}`);
  }
  const expected = Object.entries({ ...pkg.dependencies, ...pkg.devDependencies })
    .map(([name, version]) => `npm:${name}@${version}`).sort();
  assert.deepEqual([...denoLock.workspace.packageJson.dependencies].sort(), expected);
});
