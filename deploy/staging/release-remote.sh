#!/usr/bin/env bash
# release-remote.sh <sha> — the server half of a BylineCRM staging deploy (P5-4a).
#
# Runs ON the VPS, as root, invoked by deploy.sh from the copy of deploy/staging/ that deploy.sh
# uploaded for this sha (/opt/bylinecrm/releases/<sha>/deploy/staging/).
#
# Touches only the `bylinecrm-staging` compose project, /opt/bylinecrm and /opt/bylinecrm-runtime.
# It never runs a command against a NewswireOS container.
#
# Order, chosen so a failure leaves the running stack untouched for as long as possible:
#   lock → preflight (env files, the Resend key, the edge network) → pull every image (a missing image aborts here, nothing changed) → start
#   postgres/valkey (no-op when running) → migrate → api, wait healthy → web, wait serving →
#   record DEPLOYED_SHA (previous kept for rollback.sh) → prune old release directories.

set -euo pipefail

SHA=${1:?usage: release-remote.sh <full commit sha>}
RUNTIME=${BYLINECRM_RUNTIME:-/opt/bylinecrm-runtime}
RELEASES=${BYLINECRM_RELEASES:-/opt/bylinecrm/releases}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
COMPOSE_FILE="$HERE/docker-compose.yml"
LOCK="$RUNTIME/deploy.lock"
KEEP_RELEASES=5
HEALTH_TRIES=60 # × 2 s

export BYLINECRM_SHA=$SHA BYLINECRM_RUNTIME=$RUNTIME
compose() { docker compose -p bylinecrm-staging -f "$COMPOSE_FILE" "$@"; }
log() { echo "release: $*" >&2; }

# The lock is a directory: mkdir is atomic, so two deploys cannot both take it.
if ! mkdir "$LOCK" 2>/dev/null; then
    log "another BylineCRM deploy holds $LOCK ($(cat "$LOCK/holder" 2>/dev/null || echo unknown)) — refusing"
    exit 1
fi
trap 'rm -rf "$LOCK"' EXIT
echo "$SHA $(date -u +%FT%TZ) pid $$" >"$LOCK/holder"

for f in staging.env postgres.env; do
    [ -f "$RUNTIME/$f" ] || {
        log "$RUNTIME/$f missing — run bootstrap-secrets.sh first"
        exit 1
    }
done
# Production mode boots only with transactional mail configured (#93): refuse here, before anything
# is pulled or restarted, rather than leave an api that will not start.
grep -q '^RESEND_API_KEY=re_' "$RUNTIME/staging.env" || {
    log "RESEND_API_KEY missing from $RUNTIME/staging.env — install it from the Mac, then deploy again:"
    log "  pbpaste | ssh newswireos-vps 'bash $HERE/install-resend-key.sh'"
    exit 1
}
docker network inspect bylinecrm-edge >/dev/null 2>&1 || {
    log "network bylinecrm-edge missing — see docs/deploy/staging.md, one-time steps"
    exit 1
}

log "pulling images for $SHA"
compose --profile tools pull --quiet

log "starting postgres and valkey"
compose up -d --wait postgres valkey

log "migrating"
compose run --rm migrate

log "starting api"
compose up -d --no-deps api
for ((i = 1; i <= HEALTH_TRIES; i++)); do
    if compose exec -T api node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(b=>process.exit(b.status==='ok'?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then
        break
    fi
    [ "$i" = "$HEALTH_TRIES" ] && {
        log "api never reported healthy; last logs:"
        compose logs --tail 40 api >&2
        exit 1
    }
    sleep 2
done
log "api healthy"

log "starting web"
compose up -d --no-deps web
for ((i = 1; i <= HEALTH_TRIES; i++)); do
    if compose exec -T web sh -c 'wget -qO- http://127.0.0.1/ | grep -q "id=\"root\"" && wget -qO- http://127.0.0.1/health | grep -q "\"status\":\"ok\""' 2>/dev/null; then
        break
    fi
    [ "$i" = "$HEALTH_TRIES" ] && {
        log "web never served the app and the API through itself; last logs:"
        compose logs --tail 40 web >&2
        exit 1
    }
    sleep 2
done
log "web serving the app and reaching the api"

if [ -f "$RUNTIME/DEPLOYED_SHA" ] && [ "$(cat "$RUNTIME/DEPLOYED_SHA")" != "$SHA" ]; then
    cp "$RUNTIME/DEPLOYED_SHA" "$RUNTIME/PREVIOUS_SHA"
fi
echo "$SHA" >"$RUNTIME/DEPLOYED_SHA"
echo "$SHA" >>"$RUNTIME/release-history"

# Keep the release directories of the newest deployed shas (the running one is always among them);
# anything else under releases/ — older releases, uploads that never deployed — goes.
keep=$(awk '{ line[NR] = $0 } END { for (i = NR; i > 0; i--) if (!seen[line[i]]++) print line[i] }' \
    "$RUNTIME/release-history" | head -n "$KEEP_RELEASES")
for dir in "$RELEASES"/*/; do
    [ -d "$dir" ] || continue
    name=$(basename "$dir")
    grep -qxF "$name" <<<"$keep" || rm -rf "${dir%/}"
done

log "deployed $SHA"
