#!/bin/sh
# Runs in the digest-pinned data image. No host paths, public ports or Docker socket.
set -eu
umask 077
test -s /opt/localization/release-set.json
test -s /opt/localization/identity
if [ -e /release/identity ]; then
  cmp -s /release/identity /opt/localization/identity || {
    echo >&2 'Different release volume. Use a new Compose project; existing data is preserved.'
    exit 1
  }
fi
if [ ! -s /data/PG_VERSION ]; then
  minimum_kib=209715200
  case "${LOCALIZATION_RESTORE_PROFILE:-default}" in
    default) ;;
    vps-4g)
      # Measured all-12 dataset only. A future larger dataset must be re-estimated.
      test "$(cat /opt/localization/identity)" = fb53fa63afc4ad9850991e56ef0222574371e1cdb5eee228dda1f7b5e1843fc9 || {
        echo >&2 'The VPS capacity profile is not approved for this dataset.'
        exit 1
      }
      minimum_kib=188743680 ;;
    *) echo >&2 'Unknown restore capacity profile'; exit 1 ;;
  esac
  available=$(df -Pk /data | awk 'END {print $4}')
  test "$available" -ge "$minimum_kib" || {
    echo >&2 "Insufficient restore space: required ${minimum_kib} KiB; available ${available} KiB."
    exit 1
  }
fi
# Never silently replace a lost password for an already initialized cluster.
if [ -s /data/PG_VERSION ]; then
  test -s /admin/password && test -s /app-secret/db_password || {
    echo >&2 'Existing database credentials are missing. Restore the credential volumes.'
    exit 1
  }
fi
for secret in /admin/password /app-secret/db_password; do
  if [ ! -e "$secret" ]; then
    od -An -N32 -tx1 /dev/urandom | tr -d ' \n' > "$secret.tmp"
    test "$(wc -c < "$secret.tmp" | tr -d ' ')" = 64
    mv "$secret.tmp" "$secret"
  fi
  test "$(wc -c < "$secret" | tr -d ' ')" = 64
done
chmod 755 /admin
chmod 444 /admin/password
chmod 755 /release /app-secret
chmod 444 /app-secret/db_password
mkdir -p /release/bundles
cp /opt/localization/release-set.json /release/release-set.json
cp /opt/localization/bundles/*.json /release/bundles/
cp /opt/localization/identity /release/identity
chmod 755 /release/bundles
chmod 444 /release/release-set.json /release/identity /release/bundles/*.json
echo 'Release metadata and persistent random credentials prepared.'
