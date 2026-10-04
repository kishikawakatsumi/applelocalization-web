#!/usr/bin/env bash
set -Eeuo pipefail
source /opt/localization/dataset.env
if [ "$#" = 0 ]; then set -- postgres; fi
if [[ "$1" = -* ]]; then set -- postgres "$@"; fi
if [ "$1" = postgres ]; then
  if [ "${POSTGRES_DB:-$DATASET_DATABASE}" != "$DATASET_DATABASE" ] || [ -n "${POSTGRES_DB_FILE:-}" ]; then
    echo >&2 'Localization image: database name is fixed by its SQL; regenerate for another database.'
    exit 64
  fi
  if [ "${POSTGRES_USER:-postgres}" != postgres ] || [ -n "${POSTGRES_USER_FILE:-}" ]; then
    echo >&2 'Localization image: initialization requires POSTGRES_USER=postgres.'
    exit 64
  fi
  if [ "${PGDATA:-/var/lib/postgresql/data}" != /var/lib/postgresql/data ]; then
    echo >&2 'Localization image: unsupported PGDATA override.'
    exit 64
  fi
  export POSTGRES_DB="$DATASET_DATABASE"
  export PGDATA=/var/lib/postgresql/data
  (cd /opt/localization && sha256sum -c SHA256SUMS)
  if [ -s "$PGDATA/PG_VERSION" ]; then
    if ! cmp -s /opt/localization/identity "$PGDATA/.localization-ready"; then
      echo >&2 'Localization image: incomplete or different dataset volume. Preserve it for inspection; use a new empty volume.'
      exit 65
    fi
  elif [ -e "$PGDATA/.localization-ready" ]; then
    echo >&2 'Localization image: marker exists without a PostgreSQL cluster.'
    exit 65
  fi
fi
exec /usr/local/bin/docker-entrypoint.sh "$@"
