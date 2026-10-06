import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import process from "node:process";
import { createHash } from "node:crypto";
import { realpath, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { safeRead } from "../extraction/inspect-unlocalized-resources.mjs";
import { sha256 } from "../shared/localization-jsonl.mjs";
import {
  parseCopyLine,
  psqlLines,
  validateSchema,
  occurrenceSQLLayout,
  stagingDatabase,
} from "./occurrence-sql.mjs";
import { localDockerOnly } from "./load-occurrence-staging.mjs";
import {
  effectiveResource,
  validateOccurrencePackage,
  verifyOwnershipCount,
} from "../package/occurrence-package.mjs";
import { tableContext } from "../package/prepare-localization-package.mjs";

export async function* queryCopy(sql, query = psqlLines) {
  for await (
    const line of query(
      `BEGIN READ ONLY; SET LOCAL statement_timeout='10min'; COPY (${sql}) TO STDOUT; COMMIT;`,
    )
  ) yield parseCopyLine(line);
}

export async function auditOccurrenceStaging(
  { input, schema, durable = false, progress = () => {}, query = psqlLines },
) {
  if (durable) occurrenceSQLLayout({ schema, durable, database: stagingDatabase });
  else validateSchema(schema);
  localDockerOnly();
  // Internal transport injection for a freshly created, isolated restore DB.
  const copy = (sql) => queryCopy(sql, query);
  const root = await realpath(input),
    reportBytes = await safeRead(root, "report.json"),
    report = JSON.parse(reportBytes);
  validateOccurrencePackage(report);
  let packageCount = 0;
  for await (
    const [id, manifest, storedReport, storedCatalog] of copy(
      `SELECT * FROM ${schema}.package`,
    )
  ) {
    packageCount++;
    assert.equal(id, "1");
    assert.equal(manifest, sha256(reportBytes));
    assert.equal(storedReport, reportBytes.toString());
    assert.equal(sha256(storedCatalog), report.catalogSha256);
  }
  assert.equal(packageCount, 1);
  const catalog = JSON.parse(await safeRead(root, "catalog.json"));
  const resources = new Map(),
    languages = new Map(),
    bundles = new Map(),
    tables = new Map();
  for await (
    const [id, path] of copy(`SELECT * FROM ${schema}.bundle ORDER BY id`)
  ) bundles.set(Number(id), path);
  let correctedResources = 0;
  const tableRecords = new Map();
  for (
    const [stream, table] of [
      ["sources", "source"],
      ["tables", "resource_table"],
      ["resources", "resource"],
      ["issues", "issue"],
      ["symlinks", "symlink"],
    ]
  ) {
    const hash = createHash("sha256");
    let count = 0;
    for await (
      const fields of copy(`SELECT * FROM ${schema}.${table} ORDER BY id`)
    ) {
      const record = JSON.parse(fields.at(-1));
      count++;
      hash.update(JSON.stringify(record) + "\n");
      assert.equal(Number(fields[0]), count);
      if (stream === "tables") {
        assert.equal(fields[1], record.tableId);
        tables.set(Number(fields[0]), record.tableId);
        tableRecords.set(record.tableId, record);
      }
      if (stream === "resources") {
        const effective = effectiveResource(record, report);
        if (record.ownershipCorrection) correctedResources++;
        if (record.tableId !== null) {
          assert.deepEqual(
            tableRecords.get(record.tableId),
            tableContext(effective, record.supplement),
            "Incorrect table boundary",
          );
        }
        assert.equal(fields[1], record.resourceId);
        assert.equal(
          fields[2] === null ? null : tables.get(Number(fields[2])),
          record.tableId,
        );
        assert.equal(
          bundles.get(Number(fields[3])),
          effective.bundlePath,
        );
        assert.equal(fields[4], record.status);
        assert.equal(Number(fields[5]), record.rows);
        resources.set(Number(fields[0]), { record, seen: 0 });
      }
    }
    assert.equal(
      hash.digest("hex"),
      report.contentHashes[stream],
      `Metadata differs: ${stream}`,
    );
  }
  verifyOwnershipCount(report, correctedResources);
  for await (
    const [id, code, raw, basis, status, expected] of copy(
      `SELECT * FROM ${schema}.language ORDER BY id`,
    )
  ) {
    const value = {
      language: code,
      raw,
      basis,
      status,
      rows: Number(expected),
    };
    assert.deepEqual(value, catalog.languages[Number(id) - 1]);
    languages.set(Number(id), { ...value, seen: 0 });
  }
  assert.equal(languages.size, catalog.languages.length);
  let quarantineCount = 0;
  for await (
    const [path, bytes] of copy(
      `SELECT path,encode(bytes,'hex') FROM ${schema}.quarantine ORDER BY path`,
    )
  ) {
    assert.equal(sha256(Buffer.from(bytes, "hex")), report.binaryHashes[path]);
    quarantineCount++;
  }
  assert.equal(quarantineCount, Object.keys(report.binaryHashes).length);
  const hash = createHash("sha256");
  let count = 0, lastProgress = Date.now();
  for await (
    const fields of copy(`SELECT * FROM ${schema}.occurrence ORDER BY id`)
  ) {
    const [
      id,
      resourceId,
      ordinal,
      languageId,
      keyText,
      keyJSON,
      kind,
      targetText,
      targetJSON,
    ] = fields;
    assert.equal(fields.length, 9);
    const resource = resources.get(Number(resourceId)),
      language = languages.get(Number(languageId));
    assert.ok(resource && language);
    resource.seen++;
    language.seen++;
    count++;
    assert.equal(Number(id), count);
    assert.equal(Number(ordinal), resource.seen);
    const row = {
      id: Number(id),
      resourceId: resource.record.resourceId,
      resourceOrdinal: Number(ordinal),
      language: language.language,
      languageRaw: language.raw,
      languageBasis: language.basis,
      languageStatus: language.status,
      key: keyText === null ? JSON.parse(keyJSON) : keyText,
      targetKind: kind,
      target: targetText === null ? JSON.parse(targetJSON) : targetText,
    };
    hash.update(JSON.stringify(row) + "\n");
    if (Date.now() - lastProgress > 10000) {
      progress({ checkedRows: count });
      lastProgress = Date.now();
    }
  }
  assert.equal(count, report.counts.occurrences);
  assert.equal(
    hash.digest("hex"),
    report.contentHashes.occurrences,
    "Database roundtrip differs from package",
  );
  for (const { record, seen } of resources.values()) {
    assert.equal(seen, record.rows);
  }
  for (const language of languages.values()) {
    assert.equal(language.seen, language.rows);
  }
  return {
    status: "database-full-roundtrip-verified",
    schema,
    packageManifest: sha256(reportBytes),
    rows: count,
    resources: resources.size,
    languages: languages.size,
    quarantinedFiles: quarantineCount,
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      schema: { type: "string" },
      output: { type: "string" },
      durable: { type: "boolean", default: false },
    },
  });
  assert.ok(values.input && values.schema && values.output);
  await writeFile(
    values.output,
    JSON.stringify({ status: "running", schema: values.schema }) + "\n",
    { flag: "wx" },
  );
  try {
    const result = await auditOccurrenceStaging({
      ...values,
      progress: (counts) => console.log(JSON.stringify(counts)),
    });
    await writeFile(values.output, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result));
  } catch (error) {
    await writeFile(
      values.output,
      JSON.stringify({ status: "failed", error: String(error) }) + "\n",
    );
    throw error;
  }
}
