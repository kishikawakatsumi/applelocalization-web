// Bounded-memory gzip JSONL I/O. LF alone separates records, not U+2028/U+2029.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { constants, createReadStream, createWriteStream } from "node:fs";
import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { once } from "node:events";
import { createGunzip, createGzip } from "node:zlib";

export const sha256 = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
const tap = (hash) =>
  new Transform({
    transform(chunk, encoding, callback) {
      hash.update(chunk);
      callback(null, chunk);
    },
  });

export async function* readJsonLines(root, name, hashes = {}) {
  assert.match(name, /^[a-z-]+\.jsonl\.gz$/);
  const path = join(root, name), stat = await lstat(path);
  assert.ok(
    stat.isFile() && !stat.isSymbolicLink(),
    "JSONL must be a regular file",
  );
  const raw = createReadStream(path, {
    flags: constants.O_RDONLY | constants.O_NOFOLLOW,
  });
  const hash = createHash("sha256"), unzip = createGunzip();
  const done = pipeline(raw, tap(hash), unzip);
  done.catch(() => {});
  unzip.setEncoding("utf8");
  let pending = "";
  try {
    for await (const chunk of unzip) {
      pending += chunk;
      let start = 0, end;
      while ((end = pending.indexOf("\n", start)) !== -1) {
        const line = pending.slice(start, end);
        assert.ok(line.length <= 64 * 1024 ** 2, "JSONL record exceeds 64 MiB");
        if (line) yield JSON.parse(line);
        start = end + 1;
      }
      pending = pending.slice(start);
      assert.ok(
        pending.length <= 64 * 1024 ** 2,
        "JSONL record exceeds 64 MiB",
      );
    }
    if (pending) yield JSON.parse(pending);
    await done;
    hashes[name] = hash.digest("hex");
  } finally {
    raw.destroy();
    unzip.destroy();
    await done.catch(() => {});
  }
}

export class JsonLineWriter {
  constructor(path) {
    this.stream = createGzip();
    this.hash = createHash("sha256");
    this.done = pipeline(
      this.stream,
      tap(this.hash),
      createWriteStream(path, { flags: "wx" }),
    );
    this.done.catch(() => {});
    this.buffer = "";
  }
  async line(text) {
    this.buffer += text;
    if (this.buffer.length >= 256 * 1024) await this.flush();
  }
  async flush() {
    if (this.stream.destroyed) {
      throw this.stream.errored ?? new Error("Output stream closed");
    }
    if (!this.buffer) return;
    const text = this.buffer;
    this.buffer = "";
    if (!this.stream.write(text)) await once(this.stream, "drain");
  }
  async close() {
    await this.flush();
    this.stream.end();
    await this.done;
    return this.hash.digest("hex");
  }
  async abort() {
    this.stream.destroy();
    await this.done.catch(() => {});
  }
}
