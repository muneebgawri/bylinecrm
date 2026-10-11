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
#   lock → this release's bootstrap-secrets.sh (writes any value the release newly derives; keeps
#   secrets, operator-set values and the installed Resend key) → the edge network → pull every image
#   (a missing image aborts here, nothing changed) → check-env: staging.env against the NEW api image's
#   schema (a variable the release newly requires aborts here, nothing changed; #120) → start
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

# This release's own derivation of staging.env and postgres.env: a value it newly derives (a new
# variable, a renamed service's URL) is written before anything reads it. Idempotent; never prints a
# secret.
log "writing this release's environment"
BYLINECRM_RUNTIME="$RUNTIME" bash "$HERE/bootstrap-secrets.sh"
docker network inspect bylinecrm-edge >/dev/null 2>&1 || {
    log "network bylinecrm-edge missing — see docs/deploy/staging.md, one-time steps"
    exit 1
}

log "pulling images for $SHA"
compose --profile tools pull --quiet

# Does staging.env boot THIS build of the api? Asked of the new image, with the api's own schema
# (dist/cli/check-env.js), before migrating or touching the running stack: a variable this release
# newly requires is refused here and the api already serving keeps serving (#120).
log "checking the environment against this release"
check_err=$(mktemp)
if ! problems=$(compose run --rm --no-deps -T api node dist/cli/check-env.js 2>"$check_err"); then
    if [ -z "$problems" ]; then
        log "the environment check could not run:"
        cat "$check_err" >&2
    else
        log "$RUNTIME/staging.env does not boot this release — nothing was changed:"
        while IFS= read -r line; do
            log "  $line"
            case $line in
                RESEND_API_KEY:*)
                    log "    install it from the Mac: pbpaste | ssh newswireos-vps 'bash $HERE/install-resend-key.sh'"
                    ;;
            esac
        done <<<"$problems"
    fi
    rm -f "$check_err"
    exit 1
fi
rm -f "$check_err"

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
