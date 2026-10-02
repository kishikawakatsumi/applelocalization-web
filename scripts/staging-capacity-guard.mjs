// Pure checks shared by detached staging supervisors. Never inspect production.
import assert from "node:assert/strict";
import { stagingApplicationArgs } from "./occurrence-staging.mjs";

export function dfAvailableBytes(output) {
  const lines = output.trim().split(/\r?\n/);
  assert.equal(lines.length, 2, "Expected one df -Pk filesystem");
  const fields = lines[1].trim().split(/\s+/);
  assert.ok(fields.length >= 6 && /^\d+$/.test(fields[3]), "Invalid df available space");
  const bytes = Number(fields[3]) * 1024;
  assert.ok(Number.isSafeInteger(bytes), "Invalid df available space");
  return bytes;
}
export function requireCapacity({ hostBytes, dockerBytes }, minimumBytes) {
  for (const [name, bytes] of Object.entries({ hostBytes, dockerBytes })) {
    assert.ok(Number.isSafeInteger(bytes) && bytes >= 0, `Invalid ${name}`);
    assert.ok(bytes >= minimumBytes, `${name} below ${minimumBytes} bytes: ${bytes}`);
  }
}
export function terminateStagingApplicationSQL(application) {
  assert.equal(typeof application, "string");
  stagingApplicationArgs(application);
  const escaped = application.replaceAll("'", "''");
  return `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name='${escaped}' AND datname='localization_staging' AND usename='postgres' AND pid <> pg_backend_pid()`;
}
