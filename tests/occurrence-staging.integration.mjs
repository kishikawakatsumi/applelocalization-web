// Explicit local-only integration test; leaves its new, tiny schema for inspection.
import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractMountedImage } from "../scripts/extract-mounted-image.mjs";
import { inspectUnlocalizedResources } from "../scripts/inspect-unlocalized-resources.mjs";
import { extractFilenameSupplement } from "../scripts/extract-filename-localizations.mjs";
import { prepareLocalizationPackage } from "../scripts/prepare-localization-package.mjs";
import { exportOccurrenceSQL } from "../scripts/occurrence-staging.mjs";
import { loadOccurrenceStaging } from "../scripts/load-occurrence-staging.mjs";
import {
  auditOccurrenceStaging,
  queryCopy,
} from "../scripts/audit-occurrence-staging.mjs";
import {
  ownershipPackageFixture,
  records,
} from "./helpers/ownership-package-fixture.mjs";

test(
  "local PostgreSQL v2 uses corrected bundles and roundtrips original metadata and all values",
  { skip: process.env.LOCAL_IPSW_DB_TEST !== "1" },
  async () => {
    const fixture = await ownershipPackageFixture();
    const schema = `ipsw_trial_v2_fixture_${process.pid}`;
    const sql = join(fixture.temp, "sql");
    await exportOccurrenceSQL({ input: fixture.v2, output: sql, schema });
    await loadOccurrenceStaging({ input: sql, allowLocalStagingWrite: true });
    const audit = await auditOccurrenceStaging({ input: fixture.v2, schema });
    assert.equal(audit.status, "database-full-roundtrip-verified");
    assert.equal(audit.rows, (await records(fixture.v2, "occurrences")).length);
    const hits = [];
    for await (
      const row of queryCopy(
        `SELECT target_text,bundle_path FROM ${schema}.search_rows WHERE key_text='Open' AND language='ja' ORDER BY bundle_path`,
      )
    ) hits.push(row);
    assert.deepEqual(hits, [["営業中", "/Other.pptheme"], [
      "開く",
      "/Outer.app",
    ], ["開く", "/Outer.app/Inner.pptheme"]]);
    const corrected = [];
    for await (
      const row of queryCopy(
        `SELECT metadata_json FROM ${schema}.resource ORDER BY id`,
      )
    ) {
      const resource = JSON.parse(row[0]);
      if (resource.ownershipCorrection) corrected.push(resource);
    }
    assert.deepEqual(
      corrected,
      (await records(fixture.v2, "resources")).filter((r) =>
        r.ownershipCorrection
      ),
    );
    console.log(
      JSON.stringify({ schema, fixtureDirectory: fixture.temp, audit }),
    );
  },
);

test(
  "local PostgreSQL preserves every fixture value and origin including NUL and lone surrogates",
  { skip: process.env.LOCAL_IPSW_DB_TEST !== "1" },
  async () => {
    const temp = await mkdtemp(join(tmpdir(), "ipsw-staging-roundtrip-"));
    const root = join(temp, "image"),
      scan = join(temp, "scan"),
      inspection = join(temp, "inspection"),
      supplement = join(temp, "supplement"),
      data = join(temp, "package"),
      sql = join(temp, "sql");
    const put = async (path, value) => {
      await mkdir(join(root, path, ".."), { recursive: true });
      await writeFile(join(root, path), JSON.stringify(value));
    };
    const value = {
      Open: "開く",
      empty: "",
      quote: "a\t\n'\\N\\.",
      nul: "a\0b",
      surrogate: "\ud800",
      ["key\0nul"]: "鍵",
      plural: { one: "一つ", other: "%d個", nul: "\0" },
    };
    await put("A.app/Contents/Resources/Main.loctable", {
      ja: value,
      en: { Open: "Open" },
    });
    await put("B.app/Contents/Resources/Main.loctable", {
      ja: { Open: "始値" },
    });
    const siri =
      "System/Library/PrivateFrameworks/SiriTTSService.framework/Versions/A/Resources";
    await put(siri + "/Info.plist", {
      CFBundleIdentifier: "com.apple.siri.SiriTTSService",
      CFBundleDevelopmentRegion: "en",
    });
    await put(siri + "/LocalizedStrings/Interstitials/ja-JP.strings", {
      Retry: "もう一度",
    });
    const decode = (bytes) => JSON.parse(bytes.toString());
    await extractMountedImage({
      root,
      output: scan,
      label: "fixture",
      decode,
      requireReadOnlyMount: false,
      minimumFreeBytes: 0,
    });
    await inspectUnlocalizedResources({
      root,
      input: scan,
      output: inspection,
      decode,
    });
    await extractFilenameSupplement({
      root,
      scan,
      inspection,
      output: supplement,
      decode,
      requireReadOnlyMount: false,
    });
    await prepareLocalizationPackage({
      scan,
      supplement,
      output: data,
      decode,
      minimumFreeBytes: 0,
    });
    const schema = `ipsw_trial_fixture_${process.pid}`;
    const exported = await exportOccurrenceSQL({
      input: data,
      output: sql,
      schema,
    });
    assert.equal(exported.stats.keyFallbackRows, 1);
    assert.equal(exported.stats.targetFallbackRows, 2);
    await loadOccurrenceStaging({ input: sql, allowLocalStagingWrite: true });
    assert.equal(
      (await auditOccurrenceStaging({ input: data, schema })).status,
      "database-full-roundtrip-verified",
    );
    const hits = [];
    for await (
      const row of queryCopy(
        `SELECT target_text,bundle_path FROM ${schema}.search_rows WHERE key_text='Open' AND language='ja' ORDER BY target_text`,
      )
    ) hits.push(row);
    assert.equal(hits.length, 2);
    assert.notEqual(hits[0][1], hits[1][1]);
    const fullText = [];
    for await (
      const row of queryCopy(
        `SELECT target_text FROM ${schema}.search_rows WHERE target_text &@ '開く'`,
      )
    ) fullText.push(row);
    assert.deepEqual(fullText, [["開く"]]);
    console.log(JSON.stringify({ schema, fixtureDirectory: temp }));
  },
);
