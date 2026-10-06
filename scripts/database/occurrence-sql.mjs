// Local staging adapter only. No app configuration, .env, production hosts or existing table writes.
import assert from "node:assert/strict";
import process from "node:process";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, realpath, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import {
  JsonLineWriter,
  readJsonLines,
  sha256,
} from "../shared/localization-jsonl.mjs";
import { safeRead } from "../extraction/inspect-unlocalized-resources.mjs";
import {
  effectiveResource,
  validateOccurrencePackage,
  verifyOwnershipCount,
} from "../package/occurrence-package.mjs";
import { tableContext } from "../package/prepare-localization-package.mjs";
import { structuredSearchIndexSQL } from "./structured-search.mjs";

export const stagingContainer = "applelocalization-staging-ios26-20260928";
export const stagingDatabase = "localization_staging";
export function validateSchema(schema) {
  assert.match(schema, /^ipsw_trial_[a-z0-9_]{1,40}$/);
  return schema;
}
export function postgresText(value) {
  assert.equal(typeof value, "string");
  return !value.includes("\0") && value.isWellFormed();
}
export function encodeValue(value, kind = "text") {
  if (kind === "text") {
    assert.equal(typeof value, "string");
    return postgresText(value) ? [value, null] : [null, JSON.stringify(value)];
  }
  assert.ok(
    kind === "structured" && value !== null && typeof value === "object" &&
      !Array.isArray(value),
  );
  return [null, JSON.stringify(value)];
}
export function copyField(value) {
  if (value === null) return "\\N";
  const text = String(value);
  assert.ok(
    postgresText(text),
    "COPY field cannot contain NUL or unpaired surrogate",
  );
  return text.replaceAll("\\", "\\\\").replaceAll("\t", "\\t").replaceAll(
    "\n",
    "\\n",
  ).replaceAll("\r", "\\r").replaceAll("\b", "\\b").replaceAll("\f", "\\f")
    .replaceAll("\v", "\\v");
}
export function parseCopyLine(line) {
  return line.split("\t").map((field) => {
    if (field === "\\N") return null;
    return field.replace(/\\([0-7]{1,3}|x[0-9a-fA-F]{1,2}|.)/g, (_, token) => {
      if (/^[0-7]/.test(token)) return String.fromCharCode(parseInt(token, 8));
      if (token.startsWith("x") && token.length > 1) {
        return String.fromCharCode(parseInt(token.slice(1), 16));
      }
      return ({ b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" })[
        token
      ] ?? token;
    });
  });
}
export function stagingApplicationArgs(
  name = process.env.LOCALIZATION_STAGING_APPLICATION_NAME,
) {
  if (name === undefined) return [];
  assert.match(
    name,
    /^[a-z][a-z0-9_]{0,62}$/,
    "Invalid staging application name",
  );
  return ["-e", `PGAPPNAME=${name}`];
}
export function psqlProcess() {
  return spawn("docker", [
    "exec",
    "-i",
    ...stagingApplicationArgs(),
    stagingContainer,
    "psql",
    "-X",
    "-q",
    "-U",
    "postgres",
    "-d",
    stagingDatabase,
    "-v",
    "ON_ERROR_STOP=1",
    "-At",
  ], { stdio: ["pipe", "pipe", "pipe"] });
}
export async function* psqlLines(sql, spawnProcess = psqlProcess) {
  const child = spawnProcess();
  let stderr = "", pending = "";
  child.stderr.on("data", (data) => {
    stderr = (stderr + data).slice(-32000);
  });
  const done = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on(
      "close",
      (code) =>
        code === 0
          ? resolve()
          : reject(new Error(`psql exit ${code}: ${stderr}`)),
    );
  });
  done.catch(() => {});
  child.stdin.on("error", () => {});
  child.stdin.end(sql + "\n");
  child.stdout.setEncoding("utf8");
  try {
    for await (const chunk of child.stdout) {
      pending += chunk;
      let start = 0, end;
      while ((end = pending.indexOf("\n", start)) !== -1) {
        yield pending.slice(start, end);
        start = end + 1;
      }
      pending = pending.slice(start);
    }
    if (pending) yield pending;
    await done;
  } finally {
    if (child.exitCode === null) child.kill();
    await done.catch(() => {});
  }
}

export function stagingSQLHeader(schema) {
  validateSchema(schema);
  return `\\set ON_ERROR_STOP on
BEGIN;
DO $$ BEGIN IF current_database() <> '${stagingDatabase}' THEN RAISE EXCEPTION 'Wrong staging database'; END IF; END $$;
SET LOCAL lock_timeout='5s';
SET LOCAL statement_timeout='0';
CREATE SCHEMA ${schema};
CREATE UNLOGGED TABLE ${schema}.package (id integer PRIMARY KEY CHECK(id=1), manifest_sha256 text NOT NULL, report_json text NOT NULL, catalog_json text NOT NULL);
CREATE UNLOGGED TABLE ${schema}.source (id integer PRIMARY KEY, metadata_json text NOT NULL);
CREATE UNLOGGED TABLE ${schema}.bundle (id integer PRIMARY KEY, path text UNIQUE);
CREATE UNLOGGED TABLE ${schema}.resource_table (id integer PRIMARY KEY, table_id text UNIQUE NOT NULL, metadata_json text NOT NULL);
CREATE UNLOGGED TABLE ${schema}.resource (id integer PRIMARY KEY, resource_id text UNIQUE NOT NULL, table_id integer REFERENCES ${schema}.resource_table, bundle_id integer NOT NULL REFERENCES ${schema}.bundle, status text NOT NULL, expected_rows integer NOT NULL, metadata_json text NOT NULL);
CREATE UNLOGGED TABLE ${schema}.language (id smallint PRIMARY KEY, code text NOT NULL, raw text NOT NULL, basis text NOT NULL, status text NOT NULL, expected_rows bigint NOT NULL, UNIQUE(code,raw,basis,status));
CREATE UNLOGGED TABLE ${schema}.occurrence (id bigint NOT NULL, resource_id integer NOT NULL, resource_ordinal integer NOT NULL, language_id smallint NOT NULL, key_text text COLLATE "C", key_json text, target_kind text NOT NULL, target_text text COLLATE "C", target_json text, CHECK((key_text IS NULL) <> (key_json IS NULL)), CHECK((target_kind='text' AND ((target_text IS NULL) <> (target_json IS NULL))) OR (target_kind='structured' AND target_text IS NULL AND target_json IS NOT NULL)));
CREATE UNLOGGED TABLE ${schema}.issue (id integer PRIMARY KEY, metadata_json text NOT NULL);
CREATE UNLOGGED TABLE ${schema}.symlink (id integer PRIMARY KEY, metadata_json text NOT NULL);
CREATE UNLOGGED TABLE ${schema}.quarantine (path text PRIMARY KEY, bytes bytea NOT NULL);`;
}

export function stagingSQLFooter(schema, searchIndexVersion = 2) {
  validateSchema(schema);
  assert.ok([1, 2].includes(searchIndexVersion));
  return `\\echo Building constraints and search indexes
ALTER TABLE ${schema}.occurrence ADD PRIMARY KEY (id), ADD UNIQUE (resource_id,resource_ordinal), ADD FOREIGN KEY (resource_id) REFERENCES ${schema}.resource(id), ADD FOREIGN KEY (language_id) REFERENCES ${schema}.language(id);
CREATE INDEX ON ${schema}.occurrence (language_id,id);
CREATE INDEX ON ${schema}.occurrence USING hash (key_text);
CREATE INDEX ON ${schema}.occurrence USING hash (target_text);
CREATE INDEX ON ${schema}.occurrence USING pgroonga (key_text);
CREATE INDEX ON ${schema}.occurrence USING pgroonga (target_text);
${
    searchIndexVersion === 2
      ? structuredSearchIndexSQL(schema) + "\n"
      : ""
  }CREATE INDEX ON ${schema}.resource (table_id);
CREATE INDEX ON ${schema}.resource (bundle_id);
ANALYZE ${schema}.occurrence;
ANALYZE ${schema}.resource;
ANALYZE ${schema}.language;
CREATE VIEW ${schema}.search_rows AS SELECT o.id,o.resource_ordinal,o.key_text,o.target_text,o.target_kind,o.key_json,o.target_json,l.code AS language,l.raw AS language_raw,l.basis AS language_basis,l.status AS language_status,r.resource_id,r.table_id,b.path AS bundle_path FROM ${schema}.occurrence o JOIN ${schema}.resource r ON r.id=o.resource_id JOIN ${schema}.language l ON l.id=o.language_id JOIN ${schema}.bundle b ON b.id=r.bundle_id;
COMMIT;
\\echo Staging import committed`;
}

// Durable exports and local rehearsal imports require explicit durable mode.
export function occurrenceSQLLayout(
  { schema, durable = false, database, searchIndexVersion = 2 },
) {
  if (!durable) {
    validateSchema(schema);
    assert.ok(database === undefined || database === stagingDatabase);
    return {
      header: stagingSQLHeader(schema),
      footer: stagingSQLFooter(schema, searchIndexVersion),
      database: stagingDatabase,
    };
  }
  assert.equal(durable, true);
  assert.match(schema, /^localization_[a-z0-9_]{1,40}$/);
  assert.match(database ?? "", /^[a-z][a-z0-9_]{0,62}$/);
  assert.ok(
    !["postgres", "template0", "template1"].includes(database),
    "Refuse system database",
  );
  const template = "ipsw_trial_durable_template";
  const header = stagingSQLHeader(template).replaceAll(template, schema)
    .replaceAll("CREATE UNLOGGED TABLE", "CREATE TABLE")
    .replace(
      `current_database() <> '${stagingDatabase}'`,
      `current_database() <> '${database}'`,
    )
    .replace("Wrong staging database", "Wrong target database")
    .replace(
      `CREATE SCHEMA ${schema};`,
      `CREATE SCHEMA ${schema};\nREVOKE ALL ON SCHEMA ${schema} FROM PUBLIC;`,
    );
  return {
    header,
    footer: stagingSQLFooter(template, searchIndexVersion).replaceAll(
      template,
      schema,
    ).replace(
      "Staging import committed",
      "Durable occurrence import committed",
    ),
    database,
  };
}

export async function exportOccurrenceSQL(
  {
    input,
    output,
    schema,
    durable = false,
    database,
    minimumFreeBytes = 10 * 1024 ** 3,
    progress = () => {},
  },
) {
  const layout = occurrenceSQLLayout({ schema, durable, database });
  const root = await realpath(input),
    destination = join(
      await realpath(dirname(resolve(output))),
      basename(output),
    );
  assert.ok(destination !== root && !destination.startsWith(root + "/"));
  const sourceReportBytes = await safeRead(root, "report.json"),
    report = JSON.parse(sourceReportBytes);
  assert.equal(report.status, "prepared-not-imported");
  validateOccurrencePackage(report);
  assert.equal(report.outputKind, "localization-occurrence-package");
  const manifest = sha256(sourceReportBytes);
  async function space() {
    const stat = await statfs(dirname(destination));
    assert.ok(
      stat.bavail * stat.bsize >= minimumFreeBytes,
      "Insufficient free space",
    );
  }
  await space();
  await mkdir(destination);
  const sql = new JsonLineWriter(join(destination, "import.sql.gz"));
  let maximumLineBytes = 0;
  const statement = (text) => {
    // COPY fields are LF-escaped. Fixed multiline DDL is also covered by this conservative bound.
    const bytes = Buffer.byteLength(text, "utf8");
    assert.ok(
      bytes <= 256 * 1024 ** 2,
      "SQL statement exceeds 256 MiB byte limit",
    );
    maximumLineBytes = Math.max(maximumLineBytes, bytes);
    return sql.line(text + "\n");
  };
  const copy = (values) => statement(values.map(copyField).join("\t"));
  const hashes = {}, contents = {};
  async function* verified(name) {
    const hash = createHash("sha256");
    for await (
      const record of readJsonLines(root, name + ".jsonl.gz", hashes)
    ) {
      hash.update(JSON.stringify(record) + "\n");
      yield record;
    }
    contents[name] = hash.digest("hex");
    assert.equal(hashes[name + ".jsonl.gz"], report.outputHashes[name]);
    assert.equal(contents[name], report.contentHashes[name]);
  }
  const resourceIds = new Map(),
    tableIds = new Map(),
    tables = new Map(),
    bundleIds = new Map(),
    languageIds = new Map();
  const stats = {
    rows: 0,
    textRows: 0,
    structuredRows: 0,
    keyFallbackRows: 0,
    targetFallbackRows: 0,
  };
  try {
    await statement(layout.header);
    const catalogBytes = await safeRead(root, "catalog.json");
    assert.equal(sha256(catalogBytes), report.catalogSha256);
    const catalog = JSON.parse(catalogBytes);
    await statement(`COPY ${schema}.package FROM stdin;`);
    await copy([
      1,
      manifest,
      sourceReportBytes.toString(),
      catalogBytes.toString(),
    ]);
    await statement("\\.");
    for (
      const [name, table] of [
        ["sources", "source"],
        ["tables", "resource_table"],
        ["issues", "issue"],
        ["symlinks", "symlink"],
      ]
    ) {
      await statement(`COPY ${schema}.${table} FROM stdin;`);
      let id = 0;
      for await (const record of verified(name)) {
        id++;
        if (name === "tables") {
          assert.ok(!tableIds.has(record.tableId));
          tableIds.set(record.tableId, id);
          tables.set(record.tableId, record);
          await copy([id, record.tableId, JSON.stringify(record)]);
        } else await copy([id, JSON.stringify(record)]);
      }
      await statement("\\.");
    }
    const resources = [], effectiveOwners = new Map();
    let correctedResources = 0;
    for await (const record of verified("resources")) {
      const effective = effectiveResource(record, report);
      if (record.ownershipCorrection) correctedResources++;
      const path = effective.bundlePath;
      if (record.tableId !== null) {
        assert.deepEqual(
          tables.get(record.tableId),
          tableContext(effective, record.supplement),
          "Incorrect table boundary",
        );
      } else {
        assert.equal(record.status, "unresolved");
        assert.equal(record.rows, 0);
      }
      effectiveOwners.set(record.resourceId, path);
      if (!bundleIds.has(path)) bundleIds.set(path, bundleIds.size + 1);
      assert.ok(!resourceIds.has(record.resourceId));
      resourceIds.set(record.resourceId, resourceIds.size + 1);
      resources.push(record);
    }
    verifyOwnershipCount(report, correctedResources);
    await statement(`COPY ${schema}.bundle FROM stdin;`);
    for (const [path, id] of bundleIds) await copy([id, path]);
    await statement("\\.");
    await statement(`COPY ${schema}.resource FROM stdin;`);
    for (const record of resources) {
      const tableId = record.tableId === null
        ? null
        : tableIds.get(record.tableId);
      assert.ok(tableId !== undefined);
      await copy([
        resourceIds.get(record.resourceId),
        record.resourceId,
        tableId,
        bundleIds.get(effectiveOwners.get(record.resourceId)),
        record.status,
        record.rows,
        JSON.stringify(record),
      ]);
    }
    await statement("\\.");
    await statement(`COPY ${schema}.language FROM stdin;`);
    for (const language of catalog.languages) {
      const key = JSON.stringify([
        language.language,
        language.raw,
        language.basis,
        language.status,
      ]);
      assert.ok(!languageIds.has(key));
      const id = languageIds.size + 1;
      assert.ok(id <= 32767);
      languageIds.set(key, id);
      await copy([
        id,
        language.language,
        language.raw,
        language.basis,
        language.status,
        language.rows,
      ]);
    }
    await statement("\\.");
    await statement(`COPY ${schema}.quarantine FROM stdin;`);
    for (const [path, hash] of Object.entries(report.binaryHashes)) {
      const bytes = await safeRead(root, path);
      assert.equal(sha256(bytes), hash);
      await copy([path, "\\x" + bytes.toString("hex")]);
    }
    await statement("\\.");
    await statement(`COPY ${schema}.occurrence FROM stdin;`);
    let lastProgress = Date.now();
    for await (const row of verified("occurrences")) {
      const resourceId = resourceIds.get(row.resourceId),
        languageId = languageIds.get(
          JSON.stringify([
            row.language,
            row.languageRaw,
            row.languageBasis,
            row.languageStatus,
          ]),
        );
      assert.ok(resourceId && languageId);
      const [keyText, keyJSON] = encodeValue(row.key),
        [targetText, targetJSON] = encodeValue(row.target, row.targetKind);
      stats.rows++;
      assert.equal(row.id, stats.rows);
      stats[row.targetKind === "text" ? "textRows" : "structuredRows"]++;
      if (keyJSON !== null) stats.keyFallbackRows++;
      if (row.targetKind === "text" && targetJSON !== null) {
        stats.targetFallbackRows++;
      }
      await copy([
        row.id,
        resourceId,
        row.resourceOrdinal,
        languageId,
        keyText,
        keyJSON,
        row.targetKind,
        targetText,
        targetJSON,
      ]);
      if (Date.now() - lastProgress > 10000) {
        await space();
        progress(stats);
        lastProgress = Date.now();
      }
    }
    assert.equal(stats.rows, report.counts.occurrences);
    assert.equal(stats.textRows, report.counts.textRows);
    assert.equal(stats.structuredRows, report.counts.structuredRows);
    await statement("\\.");
    await statement(layout.footer);
    const sqlSha256 = await sql.close();
    const result = {
      status: durable
        ? "durable-occurrence-sql-prepared"
        : "staging-sql-prepared",
      schema,
      database: layout.database,
      ...(durable
        ? { storage: "logged", published: false, apiCompatible: false }
        : { container: stagingContainer }),
      packageManifest: manifest,
      sqlSha256,
      searchIndexVersion: 2,
      maximumLineBytes,
      stats,
      resourceCount: resourceIds.size,
      tableCount: tableIds.size,
      languageCount: languageIds.size,
      limitations: [
        durable
          ? "Logged occurrence storage candidate; actual target import, backups, roles and API release still require verification."
          : "Local staging only; unlogged tables are rebuildable and not crash-durable or replication-ready.",
        "No text deduplication or automatic source/target pairing. Search view does not change existing GET endpoints.",
        "JSON-encoded text and structured values retain original JSON; full-text search includes the serialized JSON, not decoded per-branch strings.",
      ],
    };
    await writeFile(
      join(destination, "report.json"),
      JSON.stringify(result, null, 2) + "\n",
      { flag: "wx" },
    );
    return result;
  } catch (error) {
    await sql.abort();
    throw error;
  }
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  const { values } = parseArgs({
    options: {
      input: { type: "string" },
      output: { type: "string" },
      schema: { type: "string" },
    },
  });
  assert.ok(values.input && values.output && values.schema);
  console.log(
    JSON.stringify(
      await exportOccurrenceSQL({
        ...values,
        progress: (stats) => console.log(JSON.stringify({ progress: stats })),
      }),
      null,
      2,
    ),
  );
}
