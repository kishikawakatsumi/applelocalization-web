import test from "node:test";
import assert from "node:assert/strict";
import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  copyField,
  encodeValue,
  exportOccurrenceSQL,
  parseCopyLine,
  postgresText,
  stagingApplicationArgs,
  validateSchema,
  occurrenceSQLLayout,
} from "../scripts/occurrence-staging.mjs";

test("durable layout requires explicit target and creates logged tables in a new restricted schema", () => {
  const layout = occurrenceSQLLayout({ durable: true, schema: 'localization_fixture', database: 'localization_staging' });
  assert.ok(!layout.header.includes('UNLOGGED'));
  assert.equal((layout.header.match(/CREATE TABLE /g) ?? []).length, 10);
  assert.ok(layout.header.includes('REVOKE ALL ON SCHEMA localization_fixture FROM PUBLIC;'));
  assert.ok(layout.header.includes("current_database() <> 'localization_staging'"));
  for (const database of [undefined, 'postgres', 'template0', "x';DROP"]) {
    assert.throws(() => occurrenceSQLLayout({ durable: true, schema: 'localization_fixture', database }));
  }
  assert.throws(() => occurrenceSQLLayout({ durable: true, schema: 'public', database: 'localization' }));
  assert.throws(() => occurrenceSQLLayout({ schema: 'localization_fixture' }));
});

test("staging sessions can be tagged without changing the default adapter", () => {
  assert.deepEqual(stagingApplicationArgs("source_import_001"), ["-e", "PGAPPNAME=source_import_001"]);
  for (const name of ["", "A", "a'", "a;", "a".repeat(64)]) {
    assert.throws(() => stagingApplicationArgs(name));
  }
});

test("SQL export rejects unsupported versions before creating output", async () => {
  const input = await mkdtemp(join(tmpdir(), "v2-staging-guard-"));
  const output = input + "-output";
  try {
    await writeFile(
      join(input, "report.json"),
      JSON.stringify({
        status: "prepared-not-imported",
        outputKind: "localization-occurrence-package",
        formatVersion: 3,
      }),
    );
    await assert.rejects(
      exportOccurrenceSQL({
        input,
        output,
        schema: "ipsw_trial_v2_guard",
        minimumFreeBytes: 0,
      }),
      /Unsupported occurrence package version/,
    );
    await assert.rejects(access(output), { code: "ENOENT" });
  } finally {
    await rm(input, { recursive: true, force: true });
  }
});

test("PostgreSQL-incompatible text stays reversible instead of being replaced", () => {
  for (const value of ["", "普通の文字列", "a\n\t\\N", "a\u2028b", "😀"]) {
    assert.ok(postgresText(value));
    assert.deepEqual(encodeValue(value), [value, null]);
  }
  for (const value of ["a\0b", "\ud800", "x\udfffy"]) {
    assert.ok(!postgresText(value));
    const encoded = encodeValue(value);
    assert.equal(encoded[0], null);
    assert.equal(JSON.parse(encoded[1]), value);
  }
  const structured = { one: "一つ", other: "%d個", unsupported: "\0" };
  assert.deepEqual(
    JSON.parse(encodeValue(structured, "structured")[1]),
    structured,
  );
});
test("COPY roundtrip preserves escapes, null, empty, Unicode and SQL-looking input", () => {
  const values = [
    null,
    "",
    "\\N",
    "\\.",
    "\b\f\n\r\t\v\\",
    "O'Reilly",
    "'; DROP SCHEMA public; --",
    "a\u2028b\u2029c",
    JSON.stringify("\0\ud800"),
  ];
  assert.deepEqual(parseCopyLine(values.map(copyField).join("\t")), values);
  assert.throws(() => copyField("\0"));
  assert.throws(() => copyField("\ud800"));
});
test("only isolated staging schema names are accepted", () => {
  assert.equal(
    validateSchema("ipsw_trial_macos26_20260928"),
    "ipsw_trial_macos26_20260928",
  );
  for (
    const value of [
      "public",
      "macos26",
      "ipsw_trial_x;DROP",
      "ipsw_trial_",
      "ipsw_trial_" + "x".repeat(41),
    ]
  ) assert.throws(() => validateSchema(value));
});
