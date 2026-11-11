#!/usr/bin/env bash
# GUARD-4 (#355): the outbound relay's certificate. Issues (or keeps) the Let's Encrypt certificate for
# BYLINECRM_RELAY_HOST with certbot's webroot — the edge already answers the ACME challenge on port 80 for any
# host that resolves here — and installs the renewal hook that copies the files where the relay container
# reads them (${BYLINECRM_RUNTIME}/relay-tls, owned by the image's `node` user; the relay reloads them when
# they change). Run once as root on the host, after the A record exists; certbot renews from then on.
#
#   install-relay-cert.sh <staging|production>
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
. "$HERE/lib.sh"
bylinecrm_env "${1:?usage: install-relay-cert.sh <staging|production>}"
[ -n "$BYLINECRM_RELAY_HOST" ] || {
    echo "install-relay-cert: $BYLINECRM_ENV has no BYLINECRM_RELAY_HOST" >&2
    exit 1
}
HOST=$BYLINECRM_RELAY_HOST
TARGET=$BYLINECRM_RUNTIME/relay-tls
HOOK=/etc/letsencrypt/renewal-hooks/deploy/bylinecrm-$BYLINECRM_ENV-relay.sh
# The image runs as `node` (uid 1000); the files are readable by that user and nobody else.
NODE_UID=1000

mine=$(curl -fsS -4 --max-time 10 https://ifconfig.me || true)
resolved=$(getent ahostsv4 "$HOST" | awk '{print $1; exit}' || true)
if [ -z "$resolved" ]; then
    echo "install-relay-cert: $HOST does not resolve — add the A record ($mine) first" >&2
    exit 1
fi
if [ -n "$mine" ] && [ "$resolved" != "$mine" ]; then
    echo "install-relay-cert: $HOST resolves to $resolved, this server is $mine — a DNS-only record to this server is needed (Google connects to the SMTP port; Cloudflare's proxy cannot carry it)" >&2
    exit 1
fi

cat >"$HOOK" <<HOOKEOF
#!/bin/sh
# Written by install-relay-cert.sh (BylineCRM $BYLINECRM_ENV, GUARD-4): copies the renewed relay certificate
# where the relay container reads it. certbot runs this after every renewal with RENEWED_LINEAGE set;
# run by hand it copies the current files.
set -e
LIVE=/etc/letsencrypt/live/$HOST
if [ -n "\${RENEWED_LINEAGE:-}" ] && [ "\$RENEWED_LINEAGE" != "\$LIVE" ]; then exit 0; fi
install -d -o $NODE_UID -g $NODE_UID -m 700 "$TARGET"
install -o $NODE_UID -g $NODE_UID -m 600 "\$LIVE/fullchain.pem" "$TARGET/fullchain.pem.tmp"
install -o $NODE_UID -g $NODE_UID -m 600 "\$LIVE/privkey.pem" "$TARGET/privkey.pem.tmp"
mv -f "$TARGET/fullchain.pem.tmp" "$TARGET/fullchain.pem"
mv -f "$TARGET/privkey.pem.tmp" "$TARGET/privkey.pem"
HOOKEOF
chmod 755 "$HOOK"

certbot certonly --webroot -w /var/www/certbot -d "$HOST" --cert-name "$HOST" --non-interactive --agree-tos --keep-until-expiring
sh "$HOOK"
echo "install-relay-cert: $TARGET holds the certificate for $HOST; renewals copy it through $HOOK" >&2
