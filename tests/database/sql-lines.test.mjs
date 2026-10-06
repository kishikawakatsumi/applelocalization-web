import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { gzipSync } from "node:zlib";
import {
  maximumSQLLineBytes,
  readSQLLines,
  sqlLineLimit,
} from "../../scripts/database/sql-lines.mjs";
const collect = async (iterator) => {
  const result = [];
  for await (const line of iterator) result.push(line);
  return result;
};
test("SQL byte bound stays finite, keeps legacy limit, and rejects malformed metadata", () => {
  assert.equal(sqlLineLimit({}), 64 * 1024 ** 2);
  assert.equal(
    sqlLineLimit({ maximumLineBytes: 128 * 1024 ** 2 + 4096 }),
    128 * 1024 ** 2 + 4096,
  );
  for (
    const maximumLineBytes of [0, -1, 1.5, "1024", maximumSQLLineBytes + 1]
  ) assert.throws(() => sqlLineLimit({ maximumLineBytes }));
});
test("SQL reader preserves UTF-8 and LF boundaries, rejecting over-limit bytes and truncated lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "sql-lines-")),
    path = join(root, "sql.gz");
  await writeFile(path, gzipSync("日本語\n\nlast\n"));
  assert.deepEqual(await collect(readSQLLines(path, 9)), [
    "日本語",
    "",
    "last",
  ]);
  await assert.rejects(collect(readSQLLines(path, 8)), /byte bound/);
  await writeFile(path, gzipSync("missing LF"));
  await assert.rejects(collect(readSQLLines(path, 100)), /end with LF/);
});
test("a valid >64 MiB COPY line needs an explicit export bound and is not truncated", async () => {
  const root = await mkdtemp(join(tmpdir(), "sql-large-line-")),
    path = join(root, "sql.gz"),
    size = 65 * 1024 ** 2;
  const payload = Buffer.alloc(size + 1, 97);
  payload[size] = 10;
  await writeFile(path, gzipSync(payload));
  await assert.rejects(collect(readSQLLines(path)), /byte bound/);
  let count = 0;
  for await (const line of readSQLLines(path, size)) {
    count++;
    assert.equal(line.length, size);
    assert.equal(line[0], "a");
    assert.equal(line.at(-1), "a");
  }
  assert.equal(count, 1);
});
