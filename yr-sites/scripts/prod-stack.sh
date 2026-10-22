#!/usr/bin/env bash
# Starts both sites exactly as production runs them — the production Docker image behind Caddy with the production
# Caddyfile (only the site address is switched to plain HTTP on a local port) — so the browser E2E suite can run
# against it: LED on http://127.0.0.1:4311, GRID on http://127.0.0.1:4312.
# Usage: bash scripts/prod-stack.sh up | down
set -euo pipefail
cd "$(dirname "$0")/.."
IMG=yr-sites:prod-e2e
CMD="${1:-up}"
declare -A PORT=([led]=4311 [grid]=4312)

if [ "$CMD" = down ]; then
  for s in led grid; do docker rm -f "yr-$s-app" "yr-$s-caddy" >/dev/null 2>&1 || true; docker network rm "yr-$s" >/dev/null 2>&1 || true; docker volume rm "yr-$s-site" >/dev/null 2>&1 || true; done
  exit 0
fi

docker build -t "$IMG" . >/dev/null
WORK="$(mktemp -d)"
# production Caddyfile with the HTTPS site address replaced by plain HTTP :80 and the www redirect left out
awk 'BEGIN{skip=0} /^www\.\{\$DOMAIN\}/{skip=1} skip==0{print}' deploy/Caddyfile | sed 's/^{\$DOMAIN} {/:80 {/' | sed '/Strict-Transport-Security/d' > "$WORK/Caddyfile"
for s in led grid; do
  p=${PORT[$s]}
  docker network create "yr-$s" >/dev/null
  docker volume create "yr-$s-site" >/dev/null
  docker run -d --name "yr-$s-app" --network "yr-$s" --network-alias app \
    -e SITE="$s" -e PORT=8787 -e ADMIN_PASSWORD=e2e-pass -e ERP_MODE=mock -e RATE_LIMIT_PER_MIN=1000 -e TRUSTED_PROXY_HOPS=1 \
    -e DB_PATH="/data/db/$s.sqlite" -e NEWS_DIR=/data/news -e MEDIA_DIR=/data/media -e RELEASES_DIR=/srv/site \
    -e SITE_URL="https://$s.example.com" -e PUBLIC_BASE_URL="http://127.0.0.1:$p" -e CONTENT_ENABLED=false -e GEO_ENABLED=false \
    -v "yr-$s-site:/srv/site" "$IMG" >/dev/null
  docker run -d --name "yr-$s-caddy" --network "yr-$s" -p "$p:80" -v "$WORK/Caddyfile:/etc/caddy/Caddyfile:ro" -v "yr-$s-site:/srv/site:ro" caddy:2.8.4 >/dev/null
done
for s in led grid; do
  p=${PORT[$s]}
  echo "waiting for $s (first site build inside the container)…"
  for i in $(seq 1 240); do curl -fs "http://127.0.0.1:$p/" >/dev/null 2>&1 && curl -fs "http://127.0.0.1:$p/api/health" >/dev/null 2>&1 && break; sleep 1; done
  curl -fs "http://127.0.0.1:$p/api/health" | grep -q "\"site\":\"$s\"" || { docker logs "yr-$s-app" | tail -40; docker logs "yr-$s-caddy" | tail -20; echo "FAIL $s"; exit 1; }
  echo "ok   $s on http://127.0.0.1:$p (Docker image + Caddy)"
done
