#!/usr/bin/env bash
# Build here, copy the build and Docker files to the router over ssh, (re)start the container there.
# Does not touch the proxy itself; the only router-side changes are under $DIR and the splitscope container.
#
#   scripts/deploy.sh            test, build, deploy (the first deploy also carries this machine's data over)
#   scripts/deploy.sh rollback   switch back to the previous build
#
# Settings come from deploy.env (see deploy.env.example) or the environment.
set -euo pipefail
cd "$(dirname "$0")/.."
[ -f deploy.env ] && . ./deploy.env

REMOTE="${REMOTE:?set REMOTE (ssh alias of the router) in deploy.env}"
DIR="${DIR:-/opt/splitscope}"
URL="${URL:?set URL (e.g. http://192.168.1.1:8686) in deploy.env}"

wait_up() {
  for _ in $(seq 1 60); do
    curl -fsS -o /dev/null "$URL/api/status" 2>/dev/null && return 0
    sleep 2
  done
  echo "splitscope did not come up at $URL; check: ssh $REMOTE docker logs splitscope" >&2
  return 1
}

if [ "${1:-}" = rollback ]; then
  ssh "$REMOTE" "cd '$DIR' && test -d dist.prev && mv dist dist.bad && mv dist.prev dist && mv dist.bad dist.prev && docker compose up -d --build"
  wait_up
  echo "rolled back: $URL (the build just replaced is kept as dist.prev)"
  exit 0
fi

npm test
npm run build

# first deploy: bring device names, expectations, cases, drafts and saved tests along
FIRST=0
ssh "$REMOTE" "test -f '$DIR/data/splitscope.db' || test -f '$DIR/data/route-lens.db'" || FIRST=1
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
if [ "$FIRST" = 1 ] && [ -f .env ]; then
  node --no-warnings --env-file=.env --import tsx scripts/backup.ts > "$TMP/backup.json"
fi

ssh "$REMOTE" "mkdir -p '$DIR/data' && rm -rf '$DIR/dist.new'"
COPYFILE_DISABLE=1 tar --no-xattrs -czf - dist Dockerfile docker-compose.yml | ssh "$REMOTE" "mkdir -p '$DIR/dist.new' && tar -xzf - -C '$DIR/dist.new'"
# keep the running build as dist.prev for `deploy.sh rollback`
ssh "$REMOTE" "cd '$DIR' && rm -rf dist.prev && { [ ! -d dist ] || mv dist dist.prev; } && mv dist.new/dist dist && mv dist.new/Dockerfile dist.new/docker-compose.yml . && rm -rf dist.new"

# the router-side .env (mode 600) is written once from this machine's .env, keeping only the settings
# that mean the same there (the API address, ports and file access are set by docker-compose.yml)
if ! ssh "$REMOTE" "test -f '$DIR/.env'"; then
  grep -E '^(CLASH_SECRET|ROUTER_IPS|EDIT_NETS|NODE_REGIONS|FAKE_IP_RANGE|MDNS_INTERFACE|PORT)=' .env | ssh "$REMOTE" "umask 077 && cat > '$DIR/.env'"
fi

ssh "$REMOTE" "cd '$DIR' && docker compose up -d --build && docker image prune -f >/dev/null"
wait_up

if [ "$FIRST" = 1 ] && [ -s "$TMP/backup.json" ]; then
  curl -fsS -X POST -H 'content-type: application/json' --data-binary "@$TMP/backup.json" "$URL/api/restore"
  echo
fi
echo "deployed: $URL"
