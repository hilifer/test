#!/usr/bin/env bash
# Docker smoke test: build the production image and start it the way deploy/docker-compose.yml does
# (empty data volumes, RELEASES_DIR build), then check health, seeding, the site build and the API.
# Usage: bash scripts/docker-smoke.sh [led|grid]
set -euo pipefail
SITE="${1:-led}"
cd "$(dirname "$0")/.."
IMG="yr-sites:smoke"
NAME="yr-smoke-$SITE"
DATA="$(mktemp -d)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT

docker build ${DOCKER_BUILD_ARGS:-} -f "${DOCKERFILE:-Dockerfile}" -t "$IMG" . >/dev/null
docker run -d --name "$NAME" -p 18787:8787 \
  -e SITE="$SITE" -e ADMIN_PASSWORD=smoke-pass -e ERP_MODE=mock \
  -e DB_PATH="/data/db/$SITE.sqlite" -e NEWS_DIR=/data/news -e RELEASES_DIR=/srv/site \
  -e SITE_URL=https://smoke.example.com -e PUBLIC_BASE_URL=https://smoke.example.com \
  -v "$DATA/db:/data/db" -v "$DATA/news:/data/news" "$IMG" >/dev/null

echo "waiting for health…"
for i in $(seq 1 60); do curl -fs http://127.0.0.1:18787/api/health >/dev/null && break; sleep 1; done
curl -fs http://127.0.0.1:18787/api/health | grep -q "\"site\":\"$SITE\"" || { docker logs "$NAME"; echo "FAIL health"; exit 1; }
echo "ok   health"

ls "$DATA/news"/*.md >/dev/null 2>&1 || { echo "FAIL seed articles not copied into the empty volume"; exit 1; }
echo "ok   seed articles copied into empty volume"

echo "waiting for the site build…"
for i in $(seq 1 180); do docker exec "$NAME" test -f /srv/site/current/index.html && break; sleep 1; done
docker exec "$NAME" test -f /srv/site/current/index.html || { docker logs "$NAME" | tail -40; echo "FAIL site build"; exit 1; }
docker exec "$NAME" test -f /srv/site/current/llms.txt
echo "ok   site built into /srv/site/current (atomic release)"

curl -fs -X POST http://127.0.0.1:18787/api/chat -H 'content-type: application/json' -d '{"message":"hello"}' | grep -q '"reply"' || { echo "FAIL chat"; exit 1; }
echo "ok   chat"
test "$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18787/admin)" = 401
test "$(curl -s -o /dev/null -w '%{http_code}' -u admin:smoke-pass http://127.0.0.1:18787/admin)" = 200
echo "ok   admin auth"
docker inspect --format '{{.State.Health.Status}}' "$NAME" | grep -Eq 'healthy|starting'
echo "PASS docker smoke ($SITE)"
