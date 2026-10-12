#!/usr/bin/env bash
# release-remote.sh <env> <sha> — the server half of a BylineCRM deploy (P5-4a, P5-4c).
#
# Runs ON the VPS, as root, invoked by deploy.sh from the copy of deploy/env/ that deploy.sh
# uploaded for this sha (/opt/bylinecrm/releases/<sha>/deploy/env/).
#
# Touches only the `bylinecrm-<env>` compose project, /opt/bylinecrm, the environment's runtime
# directory and — for the web cutover — the environment's own include file on the NewswireOS edge
# (through install-edge.sh, which tests and restores). It never runs a command against a NewswireOS
# container.
#
# Order, chosen so a failure leaves the running stack serving for as long as possible, and so the
# cutover itself drops no request (blue/green, doc 49 P5-4):
#   lock → this release's bootstrap-secrets.sh → the edge network → pull every image (a missing image
#   aborts here, nothing changed) → check-env: <env>.env against the NEW api image's schema (#120;
#   nothing changed) → start postgres/valkey (no-op when running) → migrate (expand, never contract:
#   the live colour keeps running against the new schema) → start the idle api colour, wait healthy →
#   point every web container at it (web-dynamic/api-upstream.conf + `nginx -s reload`: atomic per
#   worker) → start the idle web colour, wait serving → render the edge file for that colour and
#   reload the NewswireOS edge (`nginx -t` first; restored on failure) → drain and stop the old colour
#   (nginx SIGQUIT, api SIGTERM with shutdown hooks: in-flight requests finish) → record
#   ACTIVE_COLOUR and DEPLOYED_SHA (previous kept for rollback.sh) → prune old release directories.
# A failure after the new api colour started puts the web upstream back and removes the new colour;
# the old colour never stopped serving.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
bylinecrm_env "${1:?usage: release-remote.sh <staging|production> <full commit sha>}"
SHA=${2:?usage: release-remote.sh <staging|production> <full commit sha>}

RUNTIME=$BYLINECRM_RUNTIME
RELEASES=$BYLINECRM_RELEASES
COMPOSE_FILE="$HERE/docker-compose.yml"
LOCK="$RUNTIME/deploy.lock"
DYN=${DYNAMIC_DIR:-/opt/newswireos-runtime/nginx-dynamic}
KEEP_RELEASES=5
HEALTH_TRIES=${HEALTH_TRIES:-60} # × 2 s
# After the edge reload, the time given to its old workers to finish requests on the old web colour
# before that colour is told to quit (it finishes in-flight requests itself either way).
DRAIN_SECONDS=${DRAIN_SECONDS:-5}

export BYLINECRM_SHA=$SHA
compose() {
    docker compose -p "$BYLINECRM_PROJECT" --profile blue --profile green --profile tools -f "$COMPOSE_FILE" "$@"
}
log() { echo "release: $*" >&2; }

# The lock is a directory: mkdir is atomic, so two deploys cannot both take it.
if ! mkdir "$LOCK" 2>/dev/null; then
    log "another BylineCRM $BYLINECRM_ENV deploy holds $LOCK ($(cat "$LOCK/holder" 2>/dev/null || echo unknown)) — refusing"
    exit 1
fi
echo "$SHA $(date -u +%FT%TZ) pid $$" >"$LOCK/holder"

# This release's own derivation of <env>.env and postgres.env: a value it newly derives (a new
# variable, a renamed service's URL) is written before anything reads it. Idempotent; never prints a
# secret.
log "writing this release's environment ($BYLINECRM_ENV)"
bash "$HERE/bootstrap-secrets.sh" "$BYLINECRM_ENV"
docker network inspect bylinecrm-edge >/dev/null 2>&1 || {
    log "network bylinecrm-edge missing — see docs/deploy/production.md, one-time steps"
    rm -rf "$LOCK"
    exit 1
}

log "pulling images for $SHA"
compose pull --quiet

# Does <env>.env boot THIS build of the api? Asked of the new image, with the api's own schema
# (dist/cli/check-env.js), before migrating or touching the running stack: a variable this release
# newly requires is refused here and the api already serving keeps serving (#120).
log "checking the environment against this release"
check_err=$(mktemp)
if ! problems=$(compose run --rm --no-deps -T migrate node dist/cli/check-env.js 2>"$check_err"); then
    if [ -z "$problems" ]; then
        log "the environment check could not run:"
        cat "$check_err" >&2
    else
        log "$BYLINECRM_APP_ENV does not boot this release — nothing was changed:"
        while IFS= read -r line; do
            log "  $line"
            case $line in
                RESEND_API_KEY:*)
                    log "    install it from the Mac: pbpaste | ssh newswireos-vps 'bash $HERE/install-resend-key.sh $BYLINECRM_ENV'"
                    ;;
            esac
        done <<<"$problems"
    fi
    rm -f "$check_err" && rm -rf "$LOCK"
    exit 1
fi
rm -f "$check_err"

log "starting postgres and valkey"
compose up -d --wait postgres valkey

log "migrating"
compose run --rm migrate

# ── blue/green cutover ───────────────────────────────────────────────────────────────────────────
ACTIVE=$(bylinecrm_active_colour)
NEW=$(bylinecrm_other_colour "$ACTIVE")
# Containers from before colours existed (a single `api`/`web` service): drained like an old colour.
legacy_containers() {
    docker ps -aq --filter "label=com.docker.compose.project=$BYLINECRM_PROJECT" \
        --filter "label=com.docker.compose.service=$1"
}
LEGACY_API=$(legacy_containers api)
LEGACY_WEB=$(legacy_containers web)
log "live colour: $ACTIVE$([ -n "$LEGACY_API$LEGACY_WEB" ] && echo ' (plus pre-colour containers)'); releasing $NEW"

# Which api colour every web container proxies to. Written atomically; the running web containers
# pick it up with a graceful reload (new workers use it, old workers finish their requests).
point_web_at() {
    local colour=$1 tmp
    tmp=$(mktemp "$RUNTIME/web-dynamic/.api-upstream.XXXXXX")
    cat >"$tmp" <<EOF
# Written by release-remote.sh: the api colour the web containers proxy to (P5-4c).
upstream bylinecrm_api {
    server api-$colour:3000;
}
EOF
    chmod 644 "$tmp"
    mv -f "$tmp" "$RUNTIME/web-dynamic/api-upstream.conf"
    local id
    for id in $(docker ps -q --filter "label=com.docker.compose.project=$BYLINECRM_PROJECT" --filter "label=com.docker.compose.service=web-blue") \
        $(docker ps -q --filter "label=com.docker.compose.project=$BYLINECRM_PROJECT" --filter "label=com.docker.compose.service=web-green"); do
        docker exec "$id" sh -c 'nginx -t >/dev/null 2>&1 && nginx -s reload'
    done
}

api_healthy() {
    compose exec -T "api-$1" node -e "fetch('http://127.0.0.1:3000/health').then(r=>r.json()).then(b=>process.exit(b.status==='ok'?0:1)).catch(()=>process.exit(1))" 2>/dev/null
}
web_serving() {
    compose exec -T "web-$1" sh -c 'wget -qO- http://127.0.0.1/ | grep -q "id=\"root\"" && wget -qO- http://127.0.0.1/health | grep -q "\"status\":\"ok\""' 2>/dev/null
}
wait_for() { # <description> <check function> <colour> <service for logs>
    local i
    for ((i = 1; i <= HEALTH_TRIES; i++)); do
        if "$2" "$3"; then return 0; fi
        sleep 2
    done
    log "$1 never came up; last logs:"
    compose logs --tail 40 "$4" >&2 || true
    return 1
}

# Anything that fails from here until the old colour is stopped: put the web upstream back on the
# live colour and remove the new one. The live colour has been serving throughout.
phase=start
revert() {
    local status=$?
    trap - ERR EXIT
    log "FAILED during '$phase' — reverting to the $ACTIVE colour (it never stopped serving)"
    if [ "$ACTIVE" != none ]; then point_web_at "$ACTIVE" || true; fi
    compose rm -sf "api-$NEW" "web-$NEW" >/dev/null 2>&1 || true
    rm -rf "$LOCK"
    exit "$status"
}
trap revert ERR EXIT

phase="starting api-$NEW"
log "$phase"
compose up -d --no-deps "api-$NEW"
wait_for "api-$NEW" api_healthy "$NEW" "api-$NEW"
log "api-$NEW healthy"

phase="pointing web at api-$NEW"
log "$phase"
point_web_at "$NEW"

phase="starting web-$NEW"
log "$phase"
compose up -d --no-deps "web-$NEW"
wait_for "web-$NEW" web_serving "$NEW" "web-$NEW"
log "web-$NEW serving the app and reaching the api"

phase="switching the edge to web-$NEW"
if [ -f "$DYN/$BYLINECRM_EDGE_CONF" ] && grep -q 'listen 443' "$DYN/$BYLINECRM_EDGE_CONF"; then
    log "$phase"
    bash "$HERE/install-edge.sh" "$BYLINECRM_ENV" https --colour "$NEW"
elif [ -f "$DYN/$BYLINECRM_EDGE_CONF" ]; then
    log "edge file is the http-only step; no upstream to switch (install-edge.sh $BYLINECRM_ENV https after certbot)"
else
    log "no edge file installed yet — see docs/deploy/production.md, one-time steps"
fi

# From here the new colour serves; failures no longer revert.
trap - ERR EXIT
phase="draining $ACTIVE"
if [ "$ACTIVE" != none ] || [ -n "$LEGACY_API$LEGACY_WEB" ]; then
    log "$phase"
    sleep "$DRAIN_SECONDS"
    # web first (SIGQUIT: finish in-flight, exit), then api (SIGTERM: shutdown hooks drain it).
    if [ "$ACTIVE" != none ]; then
        compose stop "web-$ACTIVE" "api-$ACTIVE" >/dev/null 2>&1 || true
        compose rm -f "web-$ACTIVE" "api-$ACTIVE" >/dev/null 2>&1 || true
    fi
    if [ -n "$LEGACY_WEB" ]; then docker stop -t 30 $LEGACY_WEB >/dev/null && docker rm -f $LEGACY_WEB >/dev/null; fi
    if [ -n "$LEGACY_API" ]; then docker stop -t 45 $LEGACY_API >/dev/null && docker rm -f $LEGACY_API >/dev/null; fi
fi
echo "$NEW" >"$RUNTIME/ACTIVE_COLOUR"

if [ -f "$RUNTIME/DEPLOYED_SHA" ] && [ "$(cat "$RUNTIME/DEPLOYED_SHA")" != "$SHA" ]; then
    cp "$RUNTIME/DEPLOYED_SHA" "$RUNTIME/PREVIOUS_SHA"
fi
echo "$SHA" >"$RUNTIME/DEPLOYED_SHA"
echo "$SHA" >>"$RUNTIME/release-history"

# Keep the release directories of the newest deployed shas of EVERY environment (the directory is
# shared; a running environment's release is always among them); anything else under releases/ —
# older releases, uploads that never deployed — goes.
recent() { # <history file>
    [ -f "$1" ] || return 0
    awk '{ line[NR] = $0 } END { for (i = NR; i > 0; i--) if (!seen[line[i]]++) print line[i] }' "$1" | head -n "$KEEP_RELEASES"
}
keep=$(recent "$RUNTIME/release-history")
for other in $BYLINECRM_ENVS; do
    [ "$other" = "$BYLINECRM_ENV" ] && continue
    other_runtime=$(unset BYLINECRM_RUNTIME; bylinecrm_env "$other" && echo "$BYLINECRM_RUNTIME")
    keep=$(printf '%s\n%s' "$keep" "$(recent "$other_runtime/release-history")")
done
for dir in "$RELEASES"/*/; do
    [ -d "$dir" ] || continue
    name=$(basename "$dir")
    grep -qxF "$name" <<<"$keep" || rm -rf "${dir%/}"
done

rm -rf "$LOCK"
log "deployed $SHA to $BYLINECRM_ENV on the $NEW colour"
