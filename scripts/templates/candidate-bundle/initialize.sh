#!/usr/bin/env bash
set -Eeuo pipefail
source /opt/localization/dataset.env
test "$POSTGRES_DB" = "$DATASET_DATABASE"
test ! -e "$PGDATA/.localization-ready"
(cd /opt/localization && sha256sum -c SHA256SUMS)
export PGHOST=/var/run/postgresql
unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS
localization_psql=(psql -X --no-password --username postgres --dbname "$DATASET_DATABASE" -v ON_ERROR_STOP=1)
# Fail before any component COPY/index build if the temporary-server guard was lost.
test "$("${localization_psql[@]}" -Atqc 'SHOW autovacuum')" = off
echo 'Localization bundle: temporary-server autovacuum is off.'
"${localization_psql[@]}" -c 'CREATE EXTENSION IF NOT EXISTS pgroonga;'
while IFS=$'\t' read -r component schema manifest; do
  echo "Localization component: $component start"
  gzip -dc "/opt/localization/$component/import.sql.gz" | "${localization_psql[@]}"
  test "$("${localization_psql[@]}" -Atqc "SELECT manifest_sha256 FROM ${schema}.package WHERE id=1")" = "$manifest"
  # Also upgrades verified SQL produced before JSON fulltext was introduced.
  # The patch is hashed with the payload and checks the same package manifest.
  "${localization_psql[@]}" -f "/opt/localization/$component/structured-search.sql"
  # Verified context sidecar; never changes the ten source tables.
  "${localization_psql[@]}" -f "/opt/localization/$component/context-index.sql"
  test "$("${localization_psql[@]}" -Atqc "SELECT count(*),bool_and(c.relpersistence='p') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${schema}' AND c.relkind='r'")" = '10|t'
  echo "Localization component: $component completed"
done < /opt/localization/sources.tsv
cp /opt/localization/identity "$PGDATA/.localization-ready.tmp"
mv "$PGDATA/.localization-ready.tmp" "$PGDATA/.localization-ready"
echo 'Localization bundle: initialization completed.'
