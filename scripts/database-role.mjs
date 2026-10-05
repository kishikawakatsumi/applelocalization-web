import assert from "node:assert/strict";
import { contextSchema } from "./context-index-sql.mjs";

export function readOnlyRoleSQL(role, password, schemas) {
  assert.match(role, /^web_[a-f0-9]{24}$/);
  assert.match(password, /^[a-f0-9]{64}$/);
  assert.ok(schemas.length > 0 && new Set(schemas).size === schemas.length);
  for (const s of schemas) assert.match(s, /^localization_[a-z0-9_]{1,40}$/);
  return `BEGIN;
SET LOCAL log_statement='none';
SET LOCAL log_min_error_statement='panic';
CREATE ROLE ${role} LOGIN PASSWORD '${password}' NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
ALTER ROLE ${role} SET default_transaction_read_only=on;
GRANT CONNECT ON DATABASE localization_staging TO ${role};
${
    schemas.map((s) =>
      `GRANT USAGE ON SCHEMA ${s} TO ${role};\nGRANT SELECT ON ALL TABLES IN SCHEMA ${s} TO ${role};
DO $context_grants$ BEGIN
  IF to_regnamespace('${contextSchema(s)}') IS NOT NULL THEN
    EXECUTE 'GRANT USAGE ON SCHEMA ${contextSchema(s)} TO ${role}';
    EXECUTE 'GRANT SELECT ON ALL TABLES IN SCHEMA ${
        contextSchema(s)
      } TO ${role}';
  END IF;
END $context_grants$;`
    ).join("\n")
  }
COMMIT;
`;
}
