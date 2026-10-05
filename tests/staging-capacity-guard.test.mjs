import test from "node:test";
import assert from "node:assert/strict";
import { dfAvailableBytes, requireCapacity, terminateStagingApplicationSQL } from "../scripts/staging-capacity-guard.mjs";

test("df checks fail closed and use available rather than free/total blocks", () => {
  assert.equal(dfAvailableBytes("Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/disk1 100 40 50 45% /a b\n"), 51200);
  for (const text of ["", "error", "header\n/dev/d 100 40 -1 45% /", "header\n/dev/d 100 40 x 45% /", "header\n/dev/d 100 40 999999999999999999 45% /", "header\na\nb"]) {
    assert.throws(() => dfAvailableBytes(text));
  }
});
test("both host and Docker capacity are independently required", () => {
  requireCapacity({hostBytes: 50, dockerBytes: 50}, 50);
  for (const value of [0, 49, NaN, undefined, -1, Infinity]) {
    assert.throws(() => requireCapacity({hostBytes: value, dockerBytes: 100}, 50));
    assert.throws(() => requireCapacity({hostBytes: 100, dockerBytes: value}, 50));
  }
});
test("cancellation can only target an explicitly named staging job", () => {
  assert.match(terminateStagingApplicationSQL("job_001"), /application_name='job_001' AND datname='localization_staging' AND usename='postgres' AND pid <> pg_backend_pid/);
  for (const name of [undefined, null, "", "x' OR true --"]) assert.throws(() => terminateStagingApplicationSQL(name));
});
