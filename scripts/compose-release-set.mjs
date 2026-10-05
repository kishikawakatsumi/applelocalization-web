// Assemble already-generated per-version SQL. No extraction, DB writes or publication.
import assert from "node:assert/strict";
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { batch } from "./candidate-pipeline.mjs";
import { prepareBundleContext } from "./candidate-bundle-image.mjs";
import {
  fileHash,
  sha256,
  treeHashes,
  writeJson,
} from "./collection-checkpoints.mjs";

export function releaseTargets(value = "all") {
  const ids = value === "all"
    ? batch.targets.map((t) => t.id)
    : value.split(",");
  assert.ok(
    ids.length > 0 && new Set(ids).size === ids.length,
    "Duplicate/empty target selection",
  );
  for (const id of ids) {
    assert.ok(batch.targets.some((t) => t.id === id), "Unknown target");
  }
  return batch.targets.filter((t) => ids.includes(t.id)).map((t) => t.id);
}

export function releaseCatalog(bundles, requested = releaseTargets()) {
  assert.deepEqual(
    requested,
    releaseTargets(requested.join(",")),
    "Use canonical target order",
  );
  assert.equal(
    bundles.length,
    requested.length,
    "Every selected version is required",
  );
  const byId = new Map();
  for (const b of bundles) {
    assert.equal(b.formatVersion, 1);
    assert.equal(b.status, "candidate-sql-bundle-verified");
    assert.equal(b.apiCompatible, false);
    assert.equal(b.productionReady, false);
    assert.equal(b.published, false);
    const target = batch.targets.find((t) => t.id === b.target.id);
    assert.ok(target && requested.includes(target.id), "Unselected target");
    for (const field of ["id", "platform", "version", "build"]) {
      assert.equal(b.target[field], target[field], `Wrong target ${field}`);
    }
    assert.ok(target.build, "Acquisition route not pinned");
    assert.ok(!byId.has(target.id), "Duplicate version");
    const expected = batch.jobs.filter((c) => c.target === target.id);
    assert.ok(expected.length, "Required components not pinned");
    assert.deepEqual(
      b.components.map((c) => c.key),
      expected.map((c) => c.key),
      "Incomplete or mixed components",
    );
    for (const [i, c] of b.components.entries()) {
      assert.equal(
        c.schema,
        expected[i].schema,
        "Component belongs to another release",
      );
      for (const key of ["packageManifest", "sqlSha256", "sqlReportSha256"]) {
        assert.match(c[key] ?? "", /^[a-f0-9]{64}$/);
      }
    }
    byId.set(target.id, b);
  }
  const schemas = new Set(), keys = new Set();
  const datasets = requested.map((id) => {
    const b = byId.get(id);
    assert.ok(b, `Missing version: ${id}`);
    const { platform, version, build } = b.target;
    return {
      id,
      platform,
      version,
      build,
      components: b.components.map(({ key, schema, packageManifest }) => {
        assert.ok(
          !schemas.has(schema) && !keys.has(key),
          "Duplicate schema/component",
        );
        schemas.add(schema);
        keys.add(key);
        return { key, schema, packageManifest };
      }),
    };
  });
  return {
    formatVersion: 1,
    status: "release-set-sql-context-prepared-not-restored",
    database: "localization_staging",
    allPlannedTargets: requested.length === batch.targets.length,
    missingTargets: batch.targets.filter((t) => !requested.includes(t.id)).map((
      t,
    ) => t.id),
    searchScope: "one-platform-major-version",
    datasets,
    apiCompatible: false,
    productionReady: false,
    published: false,
  };
}

// The caller must use a verified catalog. There is deliberately no all/latest/fallback scope.
export function resolveReleaseScope(catalog, id) {
  assert.equal(catalog.searchScope, "one-platform-major-version");
  assert.ok(
    typeof id === "string" && /^(ios|macos)[0-9]+$/.test(id),
    "Explicit OS/version required",
  );
  const matches = catalog.datasets.filter((d) => d.id === id);
  assert.equal(matches.length, 1, "Unknown or ambiguous OS/version");
  return structuredClone(matches[0]);
}

export async function composeReleaseContext(
  { inputs, output, targets = "all" },
) {
  const requested = releaseTargets(targets);
  assert.equal(
    inputs.length,
    requested.length,
    "Every selected version needs a pinned SQL bundle",
  );
  const bundles = [];
  for (const input of inputs) {
    assert.ok(requested.includes(input.target), "Unexpected input target");
    assert.match(input.bundleSha256 ?? "", /^[a-f0-9]{64}$/);
    const path = join(input.sql, "bundle.json");
    assert.equal(
      await fileHash(path),
      input.bundleSha256,
      "Pinned bundle hash mismatch",
    );
    const b = JSON.parse(await readFile(path));
    assert.equal(b.target.id, input.target);
    bundles.push(b);
  }
  const catalog = releaseCatalog(bundles, requested);
  // Output must be fresh. A failure leaves an incomplete context, without SHA256SUMS.
  await mkdir(output);
  const context = join(output, "context"), payload = join(context, "payload");
  await mkdir(context);
  await mkdir(payload);
  await mkdir(join(payload, "bundles"));
  const sources = [], pins = [];
  for (const id of requested) {
    const input = inputs.find((i) => i.target === id);
    const bundle = bundles.find((b) => b.target.id === id);
    // Reuse the existing report/SQL hash guards, not another full raw-data audit.
    const prepared = join(output, id);
    for (const c of bundle.components) {
      for (
        const file of ["import.sql.gz", "report.json", "verification.json"]
      ) {
        assert.ok(
          (await lstat(join(input.sql, c.key, file))).isFile(),
          "Regular SQL files required",
        );
      }
      const report = JSON.parse(
        await readFile(join(input.sql, c.key, "report.json")),
      );
      assert.equal(
        report.sqlSha256,
        c.sqlSha256,
        "SQL report does not match bundle",
      );
    }
    await prepareBundleContext({ sql: input.sql, bundle, output: prepared });
    for (const c of bundle.components) {
      await rename(join(prepared, "payload", c.key), join(payload, c.key));
      sources.push(`${c.key}\t${c.schema}\t${c.packageManifest}\n`);
    }
    await rename(
      join(prepared, "payload/bundle.json"),
      join(payload, "bundles", `${id}.json`),
    );
    pins.push({ target: id, bundleSha256: input.bundleSha256 });
    if (id === requested[0]) {
      for (
        const file of [
          "Dockerfile",
          "initialize.sh",
          "healthcheck.sh",
          "localization-entrypoint.sh",
          "postgres-init-entrypoint.sh",
        ]
      ) {
        await copyFile(join(prepared, file), join(context, file));
      }
    }
  }
  const release = { ...catalog, inputs: pins };
  // A full 12-series restore takes longer than one version; health must allow it.
  const dockerfile = await readFile(join(context, "Dockerfile"), "utf8");
  assert.ok(dockerfile.includes("--timeout=10s --start-period=45m"));
  await writeFile(
    join(context, "Dockerfile"),
    dockerfile.replace(
      "--timeout=10s --start-period=45m",
      "--timeout=60s --start-period=120m",
    ),
  );
  await writeJson(join(payload, "release-set.json"), release);
  const identity = sha256(JSON.stringify(release));
  await writeFile(join(payload, "identity"), identity + "\n", { flag: "wx" });
  await writeFile(
    join(payload, "dataset.env"),
    "DATASET_DATABASE=localization_staging\n",
    { flag: "wx" },
  );
  await writeFile(join(payload, "sources.tsv"), sources.join(""), {
    flag: "wx",
  });
  const hashes = await treeHashes(payload);
  await writeFile(
    join(payload, "SHA256SUMS"),
    Object.entries(hashes).filter(([, h]) => h !== null).map(([p, h]) =>
      `${h.sha256}  ${p}\n`
    ).join(""),
    { flag: "wx" },
  );
  return { catalog: release, identity, context };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      inputs: { type: "string" },
      output: { type: "string" },
      targets: { type: "string", default: "all" },
    },
  });
  assert.ok(values.inputs && values.output, "--inputs and --output required");
  const result = await composeReleaseContext({
    inputs: JSON.parse(await readFile(values.inputs)),
    output: resolve(values.output),
    targets: values.targets,
  });
  console.log(JSON.stringify({
    status: result.catalog.status,
    targets: result.catalog.datasets.map((d) => d.id),
    missingTargets: result.catalog.missingTargets,
    identity: result.identity,
    context: result.context,
  }));
}
