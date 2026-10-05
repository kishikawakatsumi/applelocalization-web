#!/usr/bin/env bash
set -Eeuo pipefail
source /opt/localization/dataset.env
test "$(< /proc/1/comm)" = postgres
cmp -s /opt/localization/identity /var/lib/postgresql/data/.localization-ready
export PGHOST=/var/run/postgresql PGCONNECT_TIMEOUT=5
unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS
if [ -n "${POSTGRES_PASSWORD_FILE:-}" ]; then
  export PGPASSWORD="$(< "$POSTGRES_PASSWORD_FILE")"
else
  export PGPASSWORD="${POSTGRES_PASSWORD:-}"
fi
test "$(psql -X --no-password --username postgres --dbname "$DATASET_DATABASE" -Atqc 'SHOW autovacuum')" = on
while IFS=$'\t' read -r component schema manifest; do
  test "$(psql -X --no-password --username postgres --dbname "$DATASET_DATABASE" -Atqc "SELECT manifest_sha256 FROM ${schema}.package WHERE id=1")" = "$manifest"
done < /opt/localization/sources.tsv
