#!/usr/bin/env bash
# teardown.sh --yes [--purge-data --i-understand-this-deletes-staging-data] — remove BylineCRM staging.
#
# Runs ON the VPS, as root. Removes, in this order:
#   1. the edge include file /opt/newswireos-runtime/nginx-dynamic/bylinecrm-staging.conf, using the same
#      test-and-restore pattern as install-edge.sh: the edge (newswireos-web-1) is reloaded only after
#      `nginx -t` passes, and on failure the file is put back and the edge re-tested;
#   2. every container of the `bylinecrm-staging` compose project, and the project's own networks;
#   3. with --purge-data AND --i-understand-this-deletes-staging-data: /opt/bylinecrm-runtime/data
#      (Postgres and attachment files). Secrets (*.env) and release files are kept either way.
#
# It NEVER removes the `bylinecrm-edge` docker network. That network is SHARED: NewswireOS's edge
# container is attached to it, NewswireOS's compose declares it and NewswireOS's deploy creates it if it
# is missing. Removing it would detach the NewswireOS edge — so this script only reports who is attached.
#
# Refuses while either deploy lock is held (a BylineCRM deploy, or a NewswireOS deploy that may be
# testing and reloading the same edge).

set -euo pipefail

EDGE=${EDGE_CONTAINER:-newswireos-web-1}
DYN=${DYNAMIC_DIR:-/opt/newswireos-runtime/nginx-dynamic}
NW_LOCK=${NEWSWIREOS_LOCK:-/opt/newswireos-runtime/deploy.lock}
RUNTIME=${BYLINECRM_RUNTIME:-/opt/bylinecrm-runtime}
PROJECT=${BYLINECRM_PROJECT:-bylinecrm-staging}
SHARED_NETWORK=bylinecrm-edge
TARGET="$DYN/bylinecrm-staging.conf"

log() { echo "teardown: $*" >&2; }

yes=0 purge=0 purge_confirmed=0
for arg in "$@"; do
    case "$arg" in
        --yes) yes=1 ;;
        --purge-data) purge=1 ;;
        --i-understand-this-deletes-staging-data) purge_confirmed=1 ;;
        *)
            log "unknown argument: $arg"
            exit 2
            ;;
    esac
done

if [ "$yes" != 1 ]; then
    log "this removes BylineCRM staging (containers, its edge include file). Re-run with --yes to proceed."
    log "data is kept unless --purge-data --i-understand-this-deletes-staging-data is also given."
    exit 2
fi
if [ "$purge" = 1 ] && [ "$purge_confirmed" != 1 ]; then
    log "--purge-data deletes $RUNTIME/data for good; add --i-understand-this-deletes-staging-data to confirm."
    exit 2
fi

for lock in "$RUNTIME/deploy.lock" "$NW_LOCK"; do
    if [ -e "$lock" ]; then
        log "a deploy holds $lock — refusing; try again when it has finished"
        exit 1
    fi
done

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

# 3. Data, only when explicitly confirmed twice.
if [ "$purge" = 1 ]; then
    rm -rf "${RUNTIME:?}/data"
    log "deleted $RUNTIME/data (Postgres and attachments)"
else
    log "kept $RUNTIME/data (re-run with --purge-data --i-understand-this-deletes-staging-data to delete it)"
fi

# The shared network: report, never remove.
if docker network inspect "$SHARED_NETWORK" >/dev/null 2>&1; then
    attached=$(docker network inspect -f '{{range .Containers}}{{.Name}} {{end}}' "$SHARED_NETWORK")
    log "kept the shared network $SHARED_NETWORK; still attached: ${attached:-none}"
    log "it is shared with NewswireOS's edge — do not remove it"
else
    log "network $SHARED_NETWORK does not exist (NewswireOS's deploy recreates it when needed)"
fi
log "done"
