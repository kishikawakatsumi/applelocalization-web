import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { fileHash } from "../scripts/collection-checkpoints.mjs";
import {
  buildDurableImage,
  prepareDurableImage,
  validateImageBuild,
} from "../scripts/build-durable-image.mjs";

const baseImage = "groonga/pgroonga@sha256:" + "a".repeat(64),
  tag = "applelocalization-data-candidate:fixture";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "durable-image-")),
    input = join(root, "sql");
  await mkdir(input);
  await writeFile(
    join(input, "import.sql.gz"),
    gzipSync("-- inert context fixture, never executed\n"),
  );
  const report = {
    status: "durable-occurrence-sql-prepared",
    database: "localization_staging",
    schema: "localization_fixture",
    storage: "logged",
    packageManifest: "b".repeat(64),
    sqlSha256: await fileHash(join(input, "import.sql.gz")),
  };
  await writeFile(join(input, "report.json"), JSON.stringify(report));
  const reportSha256 = await fileHash(join(input, "report.json"));
  await writeFile(
    join(input, "verification.json"),
    JSON.stringify({
      ...report,
      status: "durable-release-sql-verified-not-imported",
      sqlReportSha256: reportSha256,
    }),
  );
  await writeFile(join(input, ".env"), "SECRET=not-for-images");
  return { input, output: join(root, "image"), reportSha256, baseImage, tag };
}
test("image build requires immutable base and local candidate namespace; never grants push authority", async () => {
  assert.doesNotThrow(() => validateImageBuild({ baseImage, tag }));
  assert.throws(() =>
    validateImageBuild({ baseImage: "groonga/pgroonga:latest", tag })
  );
  assert.throws(() =>
    validateImageBuild({ baseImage, tag: "kishikawakatsumi/production:latest" })
  );
  await assert.rejects(buildDurableImage({}), /Explicit local build approval/);
});
test("image context contains only pinned SQL, metadata and startup scripts, no workspace or credentials", async () => {
  const options = await fixture();
  const { context, plan } = await prepareDurableImage(options);
  assert.deepEqual((await readdir(context)).sort(), [
    "10-localization.sh",
    "Dockerfile",
    "localization-entrypoint.sh",
    "localization-healthcheck.sh",
    "payload",
  ]);
  assert.deepEqual((await readdir(join(context, "payload"))).sort(), [
    "SHA256SUMS",
    "dataset.env",
    "identity",
    "import.sql.gz",
    "report.json",
    "verification.json",
  ]);
  assert.equal(
    await fileHash(join(context, "payload/import.sql.gz")),
    plan.sqlSha256,
  );
  assert.equal(plan.published, false);
  assert.equal(plan.platform, "linux/amd64");
  const init = await readFile(join(context, "10-localization.sh"), "utf8");
  assert.match(init, /set -Eeuo pipefail/);
  assert.ok(
    init.indexOf("gzip -dc") <
      init.indexOf('mv "$PGDATA/.localization-ready.tmp"'),
  );
  const entry = await readFile(
    join(context, "localization-entrypoint.sh"),
    "utf8",
  );
  assert.match(entry, /incomplete or different dataset/);
  assert.ok(
    entry.indexOf("cmp -s") <
      entry.indexOf("exec /usr/local/bin/docker-entrypoint.sh"),
  );
  const health = await readFile(
    join(context, "localization-healthcheck.sh"),
    "utf8",
  );
  assert.match(health, /\/proc\/1\/comm/);
  assert.ok(!health.includes("count(*)"));
  await assert.rejects(prepareDurableImage(options), /EEXIST/);
});
test("image context refuses unpinned reports and tampered SQL", async () => {
  const options = await fixture();
  await assert.rejects(
    prepareDurableImage({ ...options, reportSha256: "0".repeat(64) }),
  );
  await writeFile(join(options.input, "import.sql.gz"), gzipSync("changed"));
  await assert.rejects(prepareDurableImage(options));
});
