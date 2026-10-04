#!/usr/bin/env bash
# Linux VPS only. Never stops the previous service or changes public routing.
set -Eeuo pipefail
umask 077
mode=${1:?mode required}
deployment_id=${2:?deployment ID required}
[[ "$deployment_id" =~ ^[a-z][a-z0-9-]{0,30}$ ]] || exit 1
deployment_root="$HOME/applelocalization-deployments/$deployment_id"

preflight() {
  test "$(uname -s)" = Linux
  test "$(uname -m)" = x86_64
  command -v flock >/dev/null
  command -v python3 >/dev/null
  command -v nohup >/dev/null
  docker compose version
  # Bind mounts and free-space checks must refer to this host, not a remote daemon.
  test "$(docker info --format '{{.OSType}}')" = linux
  case "${DOCKER_HOST:-$(docker context inspect --format '{{.Endpoints.docker.Host}}')}" in
    unix://*) ;; *) echo 'A local Docker daemon is required'; exit 1 ;;
  esac
  docker_root=$(docker info --format '{{.DockerRootDir}}')
  echo 'Docker disk availability (KiB):'
  df -Pk "$docker_root"
  echo 'Host memory (KiB):'
  awk '/MemTotal:|MemAvailable:|SwapTotal:|SwapFree:/' /proc/meminfo
  available=$(df -Pk "$docker_root" | awk 'END {print $4}')
  [[ "$available" =~ ^[0-9]+$ ]]
  if [ "$available" -lt 188743680 ]; then
    echo 'Need at least 180 GiB free on the Docker filesystem. No import started.'
    exit 1
  fi
  memory_total=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
  memory_available=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
  [[ "$memory_total" =~ ^[0-9]+$ && "$memory_available" =~ ^[0-9]+$ ]]
  if [ "$memory_total" -lt 3670016 ] || [ "$memory_available" -lt 2883584 ]; then
    echo 'Need at least 3.5 GiB total / 2.75 GiB available RAM. No import started.'
    echo 'If needed, enable maintenance and explicitly stop the old services; do not delete their data.'
    exit 1
  fi
  echo 'Preflight passed. Space is checked again AFTER image download; this is not a capacity guarantee.'
}

case "$mode" in
  preflight) preflight; exit ;;
  worker|check) ;;
  *) echo 'Unknown action'; exit 1 ;;
esac

cd "$deployment_root"
test -f deployment.json
project="al-next-$deployment_id"
compose=(docker compose --env-file /dev/null -p "$project" -f compose.yml -f images.json)
export WEB_PORT
WEB_PORT=$(python3 -c 'import json; print(json.load(open("deployment.json"))["port"])')

if [ "$mode" = check ]; then
  echo "Deployment: $deployment_id"
  if [ -f ready ]; then
    "${compose[@]}" ps -a
    python3 deploy/check-vps.py "$WEB_PORT"
    echo 'Candidate READY. Use proxy-status to confirm which generation is public.'
  elif [ -f failed ]; then
    echo 'FAILED. Existing service is unaffected. Inspect deploy.log and Compose logs on the VPS.'
    tail -n 60 deploy.log
    exit 1
  else
    echo 'NOT READY. Preparation is running or was interrupted; inspect the log/process on the VPS.'
    tail -n 30 deploy.log
    exit 1
  fi
  exit
fi

# A second worker cannot operate on the same project. Different data imports also
# share one lock, preventing concurrent jobs from invalidating capacity checks.
exec 9>"$HOME/applelocalization-deployments/import.lock"
flock -n 9 || { echo 'Another import is running'; touch failed; exit 1; }
trap 'touch failed; echo "Deployment failed. Logs and volumes preserved."' ERR
test ! -e started
touch started
preflight
test -z "$(docker ps -aq --filter "label=com.docker.compose.project=$project")"
test -z "$(docker volume ls -q --filter "label=com.docker.compose.project=$project")"
python3 - "$WEB_PORT" <<'PY'
import socket, sys
with socket.socket() as sock:
    sock.bind(('127.0.0.1', int(sys.argv[1])))
PY
"${compose[@]}" pull
web_image=$(python3 -c 'import json; print(json.load(open("deployment.json"))["webImage"])')
expected_commit=$(python3 -c 'import json; print(json.load(open("deployment.json"))["commit"])')
test "$(docker image inspect --format '{{index .Config.Labels "org.opencontainers.image.revision"}}' "$web_image")" = "$expected_commit"
preflight
# This detached worker waits for DB import, then setup, then Web health. The CI
# connection may close without terminating it. No --force-recreate / volume prune.
python3 deploy/guarded-up.py "$deployment_id" "$docker_root"
python3 deploy/check-vps.py "$WEB_PORT"
touch ready
echo 'READY. Public routing is unchanged.'
