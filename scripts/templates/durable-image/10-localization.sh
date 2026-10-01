#!/usr/bin/env bash
set -Eeuo pipefail
source /opt/localization/dataset.env
test "$POSTGRES_DB" = "$DATASET_DATABASE"
test ! -e "$PGDATA/.localization-ready"
(cd /opt/localization && sha256sum -c SHA256SUMS)
localization_psql=(psql -X --no-password --username postgres --dbname "$DATASET_DATABASE" -v ON_ERROR_STOP=1)
export PGHOST=/var/run/postgresql
unset PGHOSTADDR PGSERVICE PGSERVICEFILE PGOPTIONS
"${localization_psql[@]}" -c 'CREATE EXTENSION IF NOT EXISTS pgroonga;'
gzip -dc /opt/localization/import.sql.gz | "${localization_psql[@]}"
test "$("${localization_psql[@]}" -Atqc "SELECT manifest_sha256 FROM ${DATASET_SCHEMA}.package WHERE id=1")" = "$DATASET_MANIFEST"
test "$("${localization_psql[@]}" -Atqc "SELECT count(*),bool_and(c.relpersistence='p') FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='${DATASET_SCHEMA}' AND c.relkind='r'")" = '10|t'
# Only mark success after gzip, COPY, COMMIT and metadata checks all succeed.
cp /opt/localization/identity "$PGDATA/.localization-ready.tmp"
mv "$PGDATA/.localization-ready.tmp" "$PGDATA/.localization-ready"
echo 'Localization image: dataset initialization completed.'
