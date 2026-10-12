#!/usr/bin/env bash
# install-edge.sh <env> {http|https} [--colour blue|green] — put an environment's server blocks on
# the NewswireOS edge (P5-4a, P5-4c).
#
# Runs ON the VPS, as root. Renders deploy/env/edge-<mode>.conf.tpl for the environment (host, and
# for https the web colour the edge should send traffic to — the live colour unless --colour says
# otherwise; release-remote.sh passes the colour it has just checked) and installs it.
#
# Touches only:
#   /opt/newswireos-runtime/nginx-dynamic/bylinecrm-<env>.conf  (writes, or restores/removes)
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
# NEWSWIREOS_LOCK, EDGE_CONF_DIR, BYLINECRM_RUNTIME, CERT_DIR.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"

usage() {
    echo "usage: $0 <staging|production> {http|https} [--colour blue|green]" >&2
    exit 2
}
[ $# -ge 2 ] || usage
bylinecrm_env "$1" || usage
MODE=$2
shift 2
COLOUR=''
while [ $# -gt 0 ]; do
    case "$1" in
        --colour)
            COLOUR=${2:-}
            shift 2
            ;;
        *) usage ;;
    esac
done
case "$MODE" in
    http | https) ;;
    *) usage ;;
esac
case "$COLOUR" in
    '' | blue | green) ;;
    *) usage ;;
esac

EDGE=${EDGE_CONTAINER:-newswireos-web-1}
DYN=${DYNAMIC_DIR:-/opt/newswireos-runtime/nginx-dynamic}
LOCK=${NEWSWIREOS_LOCK:-/opt/newswireos-runtime/deploy.lock}
SRC_DIR=${EDGE_CONF_DIR:-$HERE}
RUNTIME=$BYLINECRM_RUNTIME
HOST=$BYLINECRM_PUBLIC_HOST
CERT_DIR=${CERT_DIR:-/etc/letsencrypt/live}

SRC="$SRC_DIR/edge-$MODE.conf.tpl"
TARGET="$DYN/$BYLINECRM_EDGE_CONF"
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
if [ "$MODE" = https ] && ! docker exec "$EDGE" test -s "$CERT_DIR/$HOST/fullchain.pem"; then
    echo "install-edge: no certificate for $HOST yet — run certbot first" >&2
    exit 1
fi

# The web colour the https file sends traffic to: the one asked for, else the live one, else blue
# (the colour the first release will start).
if [ -z "$COLOUR" ]; then
    COLOUR=$(bylinecrm_active_colour)
    [ "$COLOUR" = none ] && COLOUR=blue
fi
WEB_UPSTREAM="$BYLINECRM_WEB_ALIAS-$COLOUR"

mkdir -p "$RUNTIME"
had_previous=0
if [ -f "$TARGET" ]; then
    cp -p "$TARGET" "$BACKUP"
    had_previous=1
fi

# Render, then write through a temp name the edge's `*.conf` include does not match, then rename
# (atomic). The placeholders are the only variable parts; everything else is reviewed text.
tmp="$DYN/.$BYLINECRM_EDGE_CONF.tmp"
sed -e "s/__HOST__/$HOST/g" -e "s/__ENV__/$BYLINECRM_ENV/g" -e "s/__WEB_UPSTREAM__/$WEB_UPSTREAM/g" "$SRC" >"$tmp"
chmod 644 "$tmp"
mv -f "$tmp" "$TARGET"

if edge_test; then
    docker exec "$EDGE" nginx -s reload
    echo "install-edge: installed $BYLINECRM_EDGE_CONF ($MODE$([ "$MODE" = https ] && echo ", web colour $COLOUR")); nginx -t passed; edge reloaded" >&2
    exit 0
fi

echo "install-edge: nginx -t FAILED with the rendered edge-$MODE.conf.tpl — putting the edge back:" >&2
edge_test_verbose >&2 || true
if [ "$had_previous" = 1 ]; then
    mv -f "$BACKUP" "$TARGET"
    echo "install-edge: restored the previous $BYLINECRM_EDGE_CONF" >&2
else
    rm -f "$TARGET"
    echo "install-edge: removed the new $BYLINECRM_EDGE_CONF" >&2
fi
if edge_test; then
    echo "install-edge: nginx -t passes again; the edge was not reloaded and serves as before" >&2
else
    echo "install-edge: nginx -t STILL fails after restoring — inspect $DYN immediately" >&2
fi
exit 1
