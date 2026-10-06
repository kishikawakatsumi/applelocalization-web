#!/usr/bin/env bash
set -Eeuo pipefail
# Use the pinned upstream initialization lifecycle, including its socket-only
# temporary server. Never persist the maintenance override to PGDATA or pass it
# to the final server. PGroonga 4.0.4 VACUUM can remove uncommitted indexes in a
# different component while the multi-component initial restore is in progress.
source /usr/local/bin/postgres-upstream-entrypoint.sh
declare -F _main docker_temp_server_start docker_create_db_directories >/dev/null

docker_temp_server_start() {
  if [ "$1" = postgres ]; then shift; fi
  set -- "$@" -c listen_addresses='' -p "${PGPORT:-5432}" -c autovacuum=off
  NOTIFY_SOCKET= PGUSER="${PGUSER:-$POSTGRES_USER}" \
    pg_ctl -D "$PGDATA" -o "$(printf '%q ' "$@")" -w start
}

if [ "$#" = 0 ]; then set -- postgres; fi
if [[ "$1" = -* ]]; then set -- postgres "$@"; fi
# Upstream's root re-exec uses its own BASH_SOURCE. Drop privileges here instead
# so the override above is retained when re-entering this wrapper as postgres.
if [ "$1" = postgres ] && ! _pg_want_help "$@" && [ "$(id -u)" = 0 ]; then
  docker_setup_env
  docker_create_db_directories
  exec gosu postgres "$BASH_SOURCE" "$@"
fi
_main "$@"
