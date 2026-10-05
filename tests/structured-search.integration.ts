// Opt-in against the review DB; creates only a unique transaction-local fixture
// schema and always rolls it back. No release rows/indexes are changed here.
import { strict as assert } from "node:assert";
import {
  buildSearch,
  type Catalog,
  presentRow,
} from "../backend/search/api.ts";
import { sqlText } from "../scripts/verify-occurrence-search.mjs";

Deno.test({
  name:
    "JSON fulltext: indexed/reference parity, context, filters, pagination and lossless values",
  ignore: Deno.env.get("ALLOW_STRUCTURED_SEARCH_DB_TEST") !== "1",
  fn: async () => {
    const schema = `ipsw_trial_structured_${Deno.pid}`;
    const catalog: Catalog = {
      manifest: "fixture",
      sourceId: "fixture",
      total: 14,
      languages: [{
        id: 1,
        code: "ja",
        raw: "ja",
        basis: "lproj",
        status: "explicit",
        rows: 11,
      }, {
        id: 2,
        code: "en",
        raw: "en",
        basis: "lproj",
        status: "explicit",
        rows: 3,
      }],
      bundles: [{ id: 1, path: "/A.app" }, { id: 2, path: "/B.app" }],
      searchPolicy: {
        version: 1,
        mode: "strict-word",
        targetIndex: "text_fts",
        jsonIndex: "json_fts",
      },
    };
    const structured = {
      count: {
        zero: "入手可能なアップデートはありません",
        other: "%d個のアップデートが入手可能です",
      },
      NSStringLocalizedFormatKey: "%#@count@",
    };
    const special = {
      nested: { text: "特殊な翻訳", nul: "x\0y", surrogate: "\ud800" },
    };
    const metadata = (bundle: string) =>
      JSON.stringify({
        sourceId: "fixture",
        original: {
          bundleName: bundle,
          imagePath: `/${bundle}/ja.lproj/Main.stringsdict`,
          resourcePath: "ja.lproj/Main.stringsdict",
        },
      });
    const sql = [`BEGIN;
SET LOCAL statement_timeout='30s';
CREATE SCHEMA ${schema};
SET LOCAL search_path=${schema},public;
SET LOCAL pgroonga.match_escalation_threshold=-1;
SET LOCAL pgroonga.force_match_escalation=off;
CREATE TABLE occurrence(id integer PRIMARY KEY, resource_id integer, language_id smallint,key_text text,key_json text,target_kind text,target_text text,target_json text);
CREATE TABLE resource(id integer,table_id integer,bundle_id integer,resource_id text,status text,metadata_json text,expected_rows integer NOT NULL DEFAULT 0);
CREATE TABLE resource_table(id integer,table_id text);
CREATE TABLE language(id smallint,code text,raw text,basis text,status text);
CREATE TABLE bundle(id integer,path text);
INSERT INTO bundle VALUES(1,'/A.app'),(2,'/B.app');
INSERT INTO resource_table VALUES(1,'table-a'),(2,'table-b');
INSERT INTO language VALUES(1,'ja','ja','lproj','explicit'),(2,'en','en','lproj','explicit');
INSERT INTO resource(id,table_id,bundle_id,resource_id,status,metadata_json) VALUES(1,1,1,'r-a','parsed',${
      sqlText(metadata("A.app"))
    }),(2,2,2,'r-b','parsed',${sqlText(metadata("B.app"))});
INSERT INTO occurrence VALUES
(1,1,1,'Open',null,'text','開く',null),
(2,1,1,'UPDATES_AVAILABLE_COUNT',null,'structured',null,${
      sqlText(JSON.stringify(structured))
    }),
(3,1,2,'UPDATES_AVAILABLE_COUNT',null,'structured',null,'{"count":{"other":"There are %d updates"}}'),
(4,2,1,'UPDATES_AVAILABLE_COUNT',null,'structured',null,'{"other":"異なる文脈"}'),
(5,1,1,'Special',null,'structured',null,${sqlText(JSON.stringify(special))}),
(6,1,1,'LiteralJSON',null,'text','{"other":"普通のテキスト"}',null),
(7,1,2,'Open',null,'text','Open',null),
(8,1,1,'"same"',null,'text','context-marker',null),
(9,1,1,null,'"same"','text','different key storage',null),
(10,1,2,'"same"',null,'text','context translation',null),
(11,2,1,'"same"',null,'text','different resource context',null),
(12,1,1,'Repeated',null,'text','variant-marker',null),
(13,1,1,'Repeated',null,'text','variant-marker',null),
(14,1,1,'Repeated',null,'text','another translation',null);
UPDATE resource r SET expected_rows=(SELECT count(*) FROM occurrence o WHERE o.resource_id=r.id);
CREATE INDEX text_fts ON occurrence USING pgroonga(target_text);
CREATE INDEX json_fts ON occurrence USING pgroonga(target_json);
ANALYZE occurrence;`];
    const expected: { ids: number[]; total: number }[] = [];
    const testSearch = (
      params: Record<string, string>,
      ids: number[],
      total = ids.length,
      countOnly = false,
    ) => {
      const result = buildSearch(
        schema,
        catalog,
        new URLSearchParams(params),
        false,
        undefined,
        { countOnly },
      );
      const expanded = result.sql.replace(/\$(\d+)/g, (_, n) => {
        const v = result.args[Number(n) - 1];
        return Array.isArray(v)
          ? `ARRAY[${v.join(",")}]`
          : typeof v === "number"
          ? String(v)
          : sqlText(String(v));
      });
      sql.push(`SELECT row_to_json(result) FROM (${expanded}) result;`);
      expected.push({ ids, total });
    };
    testSearch({ q: "入手可能なアップデートはありません" }, [3, 2]);
    testSearch({ q: "入手可能なアップデートはありません", l: "ja" }, [2]);
    testSearch({ q: "入手可能なアップデートはありません", l: "en" }, []);
    testSearch({ q: "入手可能なアップデートはありません", b: "B.app" }, []);
    testSearch(
      {
        q: "入手可能なアップデートはありません",
        bundle_path: "/A.app",
        size: "1",
        page: "2",
      },
      [2],
      2,
    );
    testSearch({ q: "特殊な翻訳" }, [5]);
    testSearch({ q: "普通のテキスト" }, [6]);
    testSearch({ q: "開く" }, [7, 1]);
    testSearch({ q: "開く", b: "A.app" }, [7, 1]);
    testSearch({ q: "context-marker" }, [10, 8]);
    testSearch({ q: "context-marker", b: "A.app" }, [10, 8]);
    testSearch({ q: "context-marker", b: "A.app" }, [], 2, true);
    testSearch({ q: "ありません", l: "unknown" }, []);
    // Force both access paths, including their boundary, without changing rows.
    // Inventory counts choose a plan only, never membership or result counts.
    for (const inventoryRows of [20000, 20001]) {
      sql.push(`UPDATE resource SET expected_rows=${inventoryRows};`);
      testSearch({ q: "context-marker" }, [10, 8]);
      testSearch({ q: "context-marker", b: "A.app" }, [10, 8]);
      testSearch({ q: "context-marker", b: "B.app" }, []);
      testSearch({ q: "context-marker", l: "ja" }, [8]);
      testSearch({ q: "context-marker", size: "1", page: "2" }, [8], 2);
      testSearch({ q: "context-marker" }, [], 2, true);
      testSearch({ q: "variant-marker" }, [12, 13, 14]);
      testSearch({ q: "入手可能なアップデートはありません" }, [3, 2]);
      testSearch({ q: "nonexistent-sentinel-59eb" }, []);
    }
    const predicate =
      "target_text &@ pgroonga_condition('アップデート',index_name=>'text_fts') OR target_json &@ pgroonga_condition('アップデート',index_name=>'json_fts')";
    sql.push(`SET LOCAL enable_seqscan=off;
SELECT json_agg(id ORDER BY id) FROM occurrence WHERE ${predicate};
EXPLAIN (FORMAT JSON) SELECT id FROM occurrence WHERE ${predicate};
WITH reference AS MATERIALIZED (SELECT * FROM occurrence) SELECT json_agg(id ORDER BY id) FROM reference WHERE ${predicate};
ROLLBACK;`);
    const child = new Deno.Command("ssh", {
      args: [
        "-o",
        "BatchMode=yes",
        "192.168.1.175",
        "/usr/local/bin/docker exec -i localization-ui-3cac615c24f5-db-1 psql -X -q -At -U postgres -d localization_staging -v ON_ERROR_STOP=1",
      ],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
    }).spawn();
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(sql.join("\n")));
    await writer.close();
    const result = await child.output();
    assert.equal(result.code, 0, new TextDecoder().decode(result.stderr));
    const output = new TextDecoder().decode(result.stdout);
    const lines = output.trim().split("\n");
    for (const want of expected) {
      const got = JSON.parse(lines.shift()!);
      assert.equal(Number(got.total), want.total);
      const rows = JSON.parse(got.rows_json);
      assert.deepEqual(rows.map((r: { id: number }) => r.id), want.ids);
      for (const row of rows) {
        if (row.id === 2) {
          assert.deepEqual(presentRow(row).target_value, structured);
        }
        if (row.id === 5) {
          assert.deepEqual(presentRow(row).target_value, special);
        }
      }
    }
    assert.deepEqual(JSON.parse(lines.shift()!), [2]);
    const reference = JSON.parse(lines.pop()!);
    assert.deepEqual(reference, [2]);
    const plan = lines.join("\n");
    assert.ok(plan.includes('"Index Name": "text_fts"'), plan);
    assert.ok(plan.includes('"Index Name": "json_fts"'), plan);
    console.log(
      "Both fulltext indexes used; sequential reference agrees; original structures preserved",
    );
  },
});
