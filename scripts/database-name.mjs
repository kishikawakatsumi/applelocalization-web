import assert from "node:assert/strict";

// New SQL exports use this name. Existing published payloads keep their own name;
// selecting a connection is not a database migration or an SQL rewrite.
export const releaseDatabase = "applelocalization";
export const legacyReleaseDatabase = "localization_staging";

export function validateReleaseDatabase(database) {
  assert.ok(
    database === releaseDatabase || database === legacyReleaseDatabase,
    "Unsupported release database",
  );
  return database;
}

export function bundleDatabase(bundle) {
  // Bundles published before the database field was introduced used the legacy name.
  return validateReleaseDatabase(
    bundle.database === undefined ? legacyReleaseDatabase : bundle.database,
  );
}
