// COPY may hex-encode a 64 MiB quarantine file into a >128 MiB line.
// New exports record a byte bound; legacy exports retain their original 64 MiB limit.
import assert from "node:assert/strict";
import { constants, createReadStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";

export const maximumSQLLineBytes = 256 * 1024 ** 2;
export function sqlLineLimit(report) {
  const limit = report.maximumLineBytes ?? 64 * 1024 ** 2;
  assert.ok(
    Number.isSafeInteger(limit) && limit > 0 && limit <= maximumSQLLineBytes,
    "Invalid SQL line byte bound",
  );
  return limit;
}
export async function* readSQLLines(path, maximumBytes = 64 * 1024 ** 2) {
  sqlLineLimit({ maximumLineBytes: maximumBytes });
  assert.ok((await lstat(path)).isFile(), "SQL must be a regular file");
  const raw = createReadStream(path, {
      flags: constants.O_RDONLY | constants.O_NOFOLLOW,
    }),
    unzip = createGunzip();
  const controller = new AbortController();
  const done = pipeline(raw, unzip, { signal: controller.signal });
  done.catch(() => {});
  let parts = [], bytes = 0;
  const add = (part) => {
    bytes += part.length;
    assert.ok(
      bytes <= maximumBytes,
      `SQL line exceeds pinned ${maximumBytes}-byte bound`,
    );
    if (part.length) parts.push(part);
  };
  try {
    for await (const chunk of unzip) {
      let start = 0, end;
      while ((end = chunk.indexOf(10, start)) !== -1) {
        add(chunk.subarray(start, end));
        yield Buffer.concat(parts, bytes).toString("utf8");
        parts = [];
        bytes = 0;
        start = end + 1;
      }
      add(chunk.subarray(start));
    }
    assert.equal(bytes, 0, "SQL must end with LF");
    await done;
  } finally {
    controller.abort();
    raw.destroy();
    unzip.destroy();
    await done.catch(() => {});
  }
}
