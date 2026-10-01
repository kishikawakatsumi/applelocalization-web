import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

test("bounded IPSW range downloader validates ZIP64, CRC, sizes and coherent HTTP ranges", async () => {
  const result = await promisify(execFile)("python3", [
    "-B",
    "tests/ipsw_range_reader.py",
  ], { timeout: 60000 });
  assert.match(result.stderr, /OK/);
});
