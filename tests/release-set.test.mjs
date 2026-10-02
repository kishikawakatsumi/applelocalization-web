import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { batch } from "../scripts/candidate-pipeline.mjs";
import { fileHash, sha256 } from "../scripts/collection-checkpoints.mjs";
import {
  composeReleaseContext,
  releaseCatalog,
  releaseTargets,
  resolveReleaseScope,
} from "../scripts/compose-release-set.mjs";

function bundle(id) {
  return {
    formatVersion: 1,
    status: "candidate-sql-bundle-verified",
    target: batch.targets.find((t) => t.id === id),
    components: batch.jobs.filter((c) => c.target === id).map((c) => ({
      key: c.key,
      schema: c.schema,
      packageManifest: sha256(c.key),
      sqlSha256: "b".repeat(64),
      sqlReportSha256: "c".repeat(64),
    })),
    apiCompatible: false,
    productionReady: false,
    published: false,
  };
}
test("one DB catalog retains explicit platform, version, build and all components", () => {
  const ids = releaseTargets("macos27,ios27,macos15,ios15");
  const c = releaseCatalog(ids.map(bundle), ids);
  assert.equal(c.database, "localization_staging");
  assert.equal(c.allPlannedTargets, false);
  const ios = resolveReleaseScope(c, "ios27"),
    mac = resolveReleaseScope(c, "macos27");
  assert.equal(ios.platform, "iOS");
  assert.equal(mac.platform, "macOS");
  assert.equal(ios.components.length, 3);
  assert.ok(
    ios.components.every((x) => x.schema.startsWith("localization_ios27_")),
  );
  assert.ok(
    mac.components.every((x) => x.schema.startsWith("localization_macos27_")),
  );
  assert.equal(resolveReleaseScope(c, "macos15").components.length, 4);
  ios.components.length = 0;
  assert.equal(resolveReleaseScope(c, "ios27").components.length, 3);
  for (
    const id of [
      "all",
      "latest",
      "ios",
      "27",
      "ios26",
      "ios27,macos27",
      "ios27;DROP",
      undefined,
    ]
  ) {
    assert.throws(() => resolveReleaseScope(c, id));
  }
});
test("missing versions, duplicate releases, mixed OS/builds and missing components fail closed", () => {
  const ids = releaseTargets("ios27,macos27");
  for (
    const alter of [
      (b) => b.pop(),
      (b) => b[1] = structuredClone(b[0]),
      (b) => b[0].target.platform = "macOS",
      (b) => b[0].target.version = "27.0",
      (b) => b[0].target.build = "24A1",
      (b) => b[0].components.pop(),
      (b) => b[0].components[0] = structuredClone(b[1].components[0]),
      (b) => b[0].components[0].schema = b[1].components[0].schema,
      (b) => b[0].published = true,
    ]
  ) {
    const b = structuredClone(ids.map(bundle));
    alter(b);
    assert.throws(() => releaseCatalog(b, ids));
  }
  assert.throws(() => releaseCatalog([bundle("ios15")]));
  assert.equal(
    releaseCatalog([bundle("ios26")], ["ios26"]).datasets[0].components.length,
    3,
  );
  const all = releaseCatalog(releaseTargets().map(bundle));
  assert.equal(all.allPlannedTargets, true);
  assert.deepEqual(all.missingTargets, []);
  assert.throws(() => releaseTargets("ios15,ios15"));
  assert.throws(() => releaseTargets("ios99"));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "release-set-"));
  const inputs = [];
  for (const id of ["ios15", "macos15"]) {
    const b = bundle(id), sql = join(root, id);
    await mkdir(sql);
    for (const c of b.components) {
      const dir = join(sql, c.key);
      await mkdir(dir);
      await writeFile(
        join(dir, "import.sql.gz"),
        gzipSync(`-- inert SQL ${c.key}`),
      );
      c.sqlSha256 = await fileHash(join(dir, "import.sql.gz"));
      const report = {
        status: "durable-occurrence-sql-prepared",
        storage: "logged",
        database: "localization_staging",
        schema: c.schema,
        packageManifest: c.packageManifest,
        sqlSha256: c.sqlSha256,
      };
      await writeFile(join(dir, "report.json"), JSON.stringify(report));
      c.sqlReportSha256 = await fileHash(join(dir, "report.json"));
      await writeFile(
        join(dir, "verification.json"),
        JSON.stringify({
          ...report,
          status: "durable-release-sql-verified-not-imported",
          sqlReportSha256: c.sqlReportSha256,
        }),
      );
    }
    await writeFile(join(sql, "bundle.json"), JSON.stringify(b));
    await writeFile(join(sql, ".env"), "PRIVATE=not copied");
    inputs.push({
      target: id,
      sql,
      bundleSha256: await fileHash(join(sql, "bundle.json")),
    });
  }
  return { inputs, output: join(root, "assembled"), targets: "ios15,macos15" };
}
test("assembler reuses byte-identical SQL in one DB context and checksums the version catalog", async () => {
  const f = await fixture();
  const result = await composeReleaseContext(f);
  assert.equal(result.catalog.datasets.length, 2);
  assert.equal(result.catalog.productionReady, false);
  const payload = join(result.context, "payload");
  assert.ok(!(await readdir(payload)).includes(".env"));
  const mapping = await readFile(join(payload, "sources.tsv"), "utf8");
  assert.equal(mapping.trim().split("\n").length, 5);
  for (const input of f.inputs) {
    const b = JSON.parse(await readFile(join(input.sql, "bundle.json")));
    assert.equal(
      await fileHash(join(payload, "bundles", `${input.target}.json`)),
      input.bundleSha256,
    );
    for (const c of b.components) {
      assert.equal(
        await fileHash(join(payload, c.key, "import.sql.gz")),
        c.sqlSha256,
      );
    }
  }
  const hashes = await readFile(join(payload, "SHA256SUMS"), "utf8");
  assert.ok(
    hashes.includes(
      `${await fileHash(join(payload, "release-set.json"))}  release-set.json`,
    ),
  );
  assert.match(
    await readFile(join(result.context, "initialize.sh"), "utf8"),
    /done < \/opt\/localization\/sources.tsv/,
  );
  assert.match(
    await readFile(join(result.context, "Dockerfile"), "utf8"),
    /ENV POSTGRES_DB=localization_staging/,
  );
  await assert.rejects(composeReleaseContext(f), /EEXIST/);
});
test("assembler refuses altered SQL, bad bundle pins and implicit partial all-version release", async () => {
  let f = await fixture();
  f.inputs[0].bundleSha256 = "0".repeat(64);
  await assert.rejects(composeReleaseContext(f), /hash mismatch/);
  f = await fixture();
  await writeFile(join(f.inputs[0].sql, "ios15-os/import.sql.gz"), "changed");
  await assert.rejects(composeReleaseContext(f));
  await assert.rejects(
    readFile(join(f.output, "context/payload/SHA256SUMS")),
    /ENOENT/,
  );
  f = await fixture();
  delete f.targets;
  await assert.rejects(composeReleaseContext(f), /Every selected version/);
});
