#!/usr/bin/env bash
# install-edge.sh {http|https} — put BylineCRM staging's server blocks on the NewswireOS edge (P5-4a).
#
# Runs ON the VPS, as root.
#
# Touches only:
#   /opt/newswireos-runtime/nginx-dynamic/bylinecrm-staging.conf  (writes, or restores/removes)
#   the edge container newswireos-web-1: `nginx -t` and `nginx -s reload`
# NewswireOS's own files in that directory (api-upstream.conf) are never read or written.
#
# Why it is careful: NewswireOS releases gate their reloads on `nginx -t`. If this file left the
# edge failing `nginx -t`, the next NewswireOS release would roll back for a reason that is not its
# own. So the script (1) refuses while a NewswireOS deploy holds its lock, (2) refuses unless the edge
# passes `nginx -t` BEFORE any change, and (3) on a failed test restores the previous file (or
# removes the new one) and proves `nginx -t` passes again before exiting non-zero.
#
# Overridable for the local test (never needed on the VPS): EDGE_CONTAINER, DYNAMIC_DIR,
# NEWSWIREOS_LOCK, EDGE_CONF_DIR, BYLINECRM_RUNTIME.

set -euo pipefail

MODE=${1:-}
case "$MODE" in
    http | https) ;;
    *)
        echo "usage: $0 {http|https}" >&2
        exit 2
        ;;
esac

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
EDGE=${EDGE_CONTAINER:-newswireos-web-1}
DYN=${DYNAMIC_DIR:-/opt/newswireos-runtime/nginx-dynamic}
LOCK=${NEWSWIREOS_LOCK:-/opt/newswireos-runtime/deploy.lock}
SRC_DIR=${EDGE_CONF_DIR:-$HERE}
RUNTIME=${BYLINECRM_RUNTIME:-/opt/bylinecrm-runtime}

SRC="$SRC_DIR/edge-$MODE.conf"
TARGET="$DYN/bylinecrm-staging.conf"
BACKUP="$RUNTIME/edge-previous.conf"

edge_test() { docker exec "$EDGE" nginx -t >/dev/null 2>&1; }
edge_test_verbose() { docker exec "$EDGE" nginx -t; }

[ -f "$SRC" ] || {
    echo "install-edge: $SRC not found" >&2
    exit 1
}
if [ -e "$LOCK" ]; then
    echo "install-edge: a NewswireOS deploy holds $LOCK — refusing; try again when it has finished" >&2
    exit 1
fi
if ! edge_test; then
    echo "install-edge: the edge fails nginx -t BEFORE any change — not ours to fix; refusing:" >&2
    edge_test_verbose >&2 || true
    exit 1
fi
if [ "$MODE" = https ] && ! docker exec "$EDGE" test -s /etc/letsencrypt/live/staging.crm.pinionnewswire.com/fullchain.pem; then
    echo "install-edge: no certificate for staging.crm.pinionnewswire.com yet — run certbot first" >&2
    exit 1
fi

mkdir -p "$RUNTIME"
had_previous=0
if [ -f "$TARGET" ]; then
    cp -p "$TARGET" "$BACKUP"
    had_previous=1
fi

# Write through a temp name the edge's `*.conf` include does not match, then rename (atomic).
tmp="$DYN/.bylinecrm-staging.conf.tmp"
cp "$SRC" "$tmp"
chmod 644 "$tmp"
mv -f "$tmp" "$TARGET"

if edge_test; then
    docker exec "$EDGE" nginx -s reload
    echo "install-edge: installed edge-$MODE.conf; nginx -t passed; edge reloaded" >&2
    exit 0
fi

echo "install-edge: nginx -t FAILED with edge-$MODE.conf — putting the edge back:" >&2
edge_test_verbose >&2 || true
if [ "$had_previous" = 1 ]; then
    mv -f "$BACKUP" "$TARGET"
    echo "install-edge: restored the previous bylinecrm-staging.conf" >&2
else
    rm -f "$TARGET"
    echo "install-edge: removed the new bylinecrm-staging.conf" >&2
fi
if edge_test; then
    echo "install-edge: nginx -t passes again; the edge was not reloaded and serves as before" >&2
else
    echo "install-edge: nginx -t STILL fails after restoring — inspect $DYN immediately" >&2
fi
exit 1
