#!/usr/bin/env bash
# teardown.sh <env> --yes [--purge-data --i-understand-this-deletes-<env>-data] — remove a BylineCRM
# environment (P5-4a, P5-4c).
#
# Runs ON the VPS, as root. For PRODUCTION it also asks for the word `production` to be typed at the
# terminal; no flag stands in for that. Removes, in this order:
#   1. the environment's edge include file /opt/newswireos-runtime/nginx-dynamic/bylinecrm-<env>.conf,
#      using the same test-and-restore pattern as install-edge.sh: the edge (newswireos-web-1) is
#      reloaded only after `nginx -t` passes, and on failure the file is put back and the edge re-tested;
#   2. every container of the `bylinecrm-<env>` compose project, and the project's own networks;
#   3. with --purge-data AND --i-understand-this-deletes-<env>-data: the runtime data directory
#      (Postgres, Valkey and attachment files). Secrets (*.env) and release files are kept either way.
#
# It NEVER removes the `bylinecrm-edge` docker network. That network is SHARED: NewswireOS's edge
# container is attached to it, NewswireOS's compose declares it and NewswireOS's deploy creates it if it
# is missing, and the other BylineCRM environment uses it too. Removing it would detach them all — so
# this script only reports who is attached.
#
# Refuses while either deploy lock is held (a BylineCRM deploy of this environment, or a NewswireOS
# deploy that may be testing and reloading the same edge).

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
bylinecrm_env "${1:?usage: teardown.sh <staging|production> --yes [--purge-data --i-understand-this-deletes-<env>-data]}"
shift

EDGE=${EDGE_CONTAINER:-newswireos-web-1}
DYN=${DYNAMIC_DIR:-/opt/newswireos-runtime/nginx-dynamic}
NW_LOCK=${NEWSWIREOS_LOCK:-/opt/newswireos-runtime/deploy.lock}
RUNTIME=$BYLINECRM_RUNTIME
PROJECT=$BYLINECRM_PROJECT
SHARED_NETWORK=bylinecrm-edge
TARGET="$DYN/$BYLINECRM_EDGE_CONF"
PURGE_FLAG="--i-understand-this-deletes-$BYLINECRM_ENV-data"

log() { echo "teardown: $*" >&2; }

yes=0 purge=0 purge_confirmed=0
for arg in "$@"; do
    case "$arg" in
        --yes) yes=1 ;;
        --purge-data) purge=1 ;;
        "$PURGE_FLAG") purge_confirmed=1 ;;
        *)
            log "unknown argument: $arg"
            exit 2
            ;;
    esac
done

if [ "$yes" != 1 ]; then
    log "this removes BylineCRM $BYLINECRM_ENV (containers, its edge include file). Re-run with --yes to proceed."
    log "data is kept unless --purge-data $PURGE_FLAG is also given."
    exit 2
fi
if [ "$purge" = 1 ] && [ "$purge_confirmed" != 1 ]; then
    log "--purge-data deletes $RUNTIME/data for good; add $PURGE_FLAG to confirm."
    exit 2
fi
if [ "$BYLINECRM_ENV" = production ]; then
    # Typed, at a terminal, every time: there is no flag for this and no way to script it.
    if [ ! -t 0 ]; then
        log "removing PRODUCTION needs the word 'production' typed at a terminal — refusing (stdin is not a terminal)"
        exit 2
    fi
    printf 'teardown: this removes PRODUCTION (%s). Type "production" to continue: ' "$BYLINECRM_PUBLIC_HOST" >&2
    IFS= read -r typed
    if [ "$typed" != production ]; then
        log "not confirmed; nothing changed"
        exit 2
    fi
fi

if [ -e "$RUNTIME/deploy.lock" ]; then
    log "a deploy holds $RUNTIME/deploy.lock — refusing; try again when it has finished"
    exit 1
fi
# NewswireOS's lock is taken, not only checked, for as long as this changes the edge (PNW-1193). A
# teardown is a person at a terminal: it does not wait, it refuses and says who holds it.
export NEWSWIREOS_LOCK=$NW_LOCK
bylinecrm_nw_lock_take teardown 0 || exit 1
trap bylinecrm_nw_lock_release EXIT

edge_test() { docker exec "$EDGE" nginx -t >/dev/null 2>&1; }

# 1. The edge include file — removed only if the edge still passes `nginx -t` without it.
if [ -f "$TARGET" ]; then
    if ! edge_test; then
        log "the edge fails nginx -t BEFORE any change — not ours to fix; refusing"
        docker exec "$EDGE" nginx -t >&2 || true
        exit 1
    fi
    mkdir -p "$RUNTIME"
    backup=$(mktemp "${RUNTIME%/}/edge-teardown.XXXXXX")
    cp -p "$TARGET" "$backup"
    rm -f "$TARGET"
    if edge_test; then
        docker exec "$EDGE" nginx -s reload
        rm -f "$backup"
        log "removed $TARGET; nginx -t passed; edge reloaded"
    else
        # Capture why it failed BEFORE restoring, so the output shows the failure, not the fix.
        failure=$(docker exec "$EDGE" nginx -t 2>&1 || true)
        mv -f "$backup" "$TARGET"
        log "nginx -t FAILED without $TARGET — put it back. The failure was:"
        printf '%s\n' "$failure" >&2
        if edge_test; then
            log "nginx -t passes again; the edge was not reloaded and serves as before"
        else
            log "nginx -t STILL fails after restoring — inspect $DYN immediately"
        fi
        exit 1
    fi
else
    log "no edge include file at $TARGET — nothing to remove there"
fi

# 2. The project's containers and its own networks (never the shared one).
containers=$(docker ps -aq --filter "label=com.docker.compose.project=$PROJECT")
if [ -n "$containers" ]; then
    # shellcheck disable=SC2086 # a word list of container ids, by design
    docker rm -f $containers >/dev/null
    log "removed $(echo "$containers" | wc -w | tr -d ' ') container(s) of project $PROJECT"
else
    log "no containers of project $PROJECT"
fi
for net in $(docker network ls -q --filter "label=com.docker.compose.project=$PROJECT"); do
    name=$(docker network inspect -f '{{.Name}}' "$net")
    if [ "$name" = "$SHARED_NETWORK" ]; then
        log "skipping $SHARED_NETWORK — shared, never removed here"
        continue
    fi
    docker network rm "$net" >/dev/null
    log "removed project network $name"
done
rm -f "$RUNTIME/ACTIVE_COLOUR"

# 3. Data, only when explicitly confirmed twice.
if [ "$purge" = 1 ]; then
    rm -rf "${RUNTIME:?}/data"
    log "deleted $RUNTIME/data (Postgres, Valkey and attachments)"
else
    log "kept $RUNTIME/data (re-run with --purge-data $PURGE_FLAG to delete it)"
fi

# The shared network: report, never remove.
if docker network inspect "$SHARED_NETWORK" >/dev/null 2>&1; then
    attached=$(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$SHARED_NETWORK")
    log "kept the shared network $SHARED_NETWORK; still attached: ${attached:-none}"
    log "it is shared with NewswireOS's edge and the other BylineCRM environment — do not remove it"
else
    log "network $SHARED_NETWORK does not exist (NewswireOS's deploy recreates it when needed)"
fi
log "done"
