#!/usr/bin/env bash
# install-resend-key.sh — install BylineCRM staging's Resend API key (#93, D-246) from stdin.
#
# Runs ON the VPS, as root. The key arrives on stdin and only there: it is never an argument (argv
# is visible in `ps` and shell history), never echoed, never logged. The owner runs it from the Mac
# with the key on the clipboard (docs/deploy/staging.md):
#
#   pbpaste | ssh newswireos-vps 'bash /opt/bylinecrm/releases/<sha>/deploy/staging/install-resend-key.sh'
#
# It rewrites $BYLINECRM_RUNTIME/staging.env atomically (0600) with the key replaced or added, and
# leaves every other line as it was. bootstrap-secrets.sh keeps the key on later runs. The api reads
# its environment at start: restart it afterwards (the script says how).

set -euo pipefail

RUNTIME=${BYLINECRM_RUNTIME:-/opt/bylinecrm-runtime}
APP_ENV="$RUNTIME/staging.env"

die() {
    echo "install-resend-key: $*; nothing changed" >&2
    exit 1
}

[ "$(id -u)" = 0 ] || die "run as root"
[ -f "$APP_ENV" ] || die "$APP_ENV missing — run bootstrap-secrets.sh first"
[ -t 0 ] && die "the key must come on stdin (pbpaste | ssh …), not from a terminal"

KEY=''
IFS= read -r KEY || true
# A clipboard copy may carry a trailing newline or CR, or surrounding spaces.
KEY=${KEY%$'\r'}
KEY=$(printf '%s' "$KEY" | tr -d '[:space:]')
[[ $KEY =~ ^re_[A-Za-z0-9_]+$ ]] || die "stdin is not a Resend API key (re_…)"

umask 077
tmp=$(mktemp "${APP_ENV}.XXXXXX")
trap 'rm -f "$tmp"' EXIT
grep -v '^RESEND_API_KEY=' "$APP_ENV" >"$tmp" || true
printf 'RESEND_API_KEY=%s\n' "$KEY" >>"$tmp"
chmod 600 "$tmp"
mv -f "$tmp" "$APP_ENV"
trap - EXIT

echo "install-resend-key: RESEND_API_KEY installed (ends …${KEY: -4}) in $APP_ENV (0600)." >&2
echo "install-resend-key: restart the api to use it: docker compose -p bylinecrm-staging restart api" >&2
