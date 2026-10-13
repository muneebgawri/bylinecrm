#!/usr/bin/env bash
# install-backup.sh <env> — install the nightly backup timer for an environment (P5-4c).
#
# Runs ON the VPS, as root. Copies the backup tooling of THIS release (backup.sh, restore.sh, lib.sh)
# to /opt/bylinecrm/tools/<env>/ — a stable path the systemd unit points at, independent of which
# release directories are kept — and enables bylinecrm-backup@<env>.timer. Re-run after a change to
# backup.sh lands; the timer itself is a template unit shared by every environment.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
bylinecrm_env "${1:?usage: install-backup.sh <staging|production>}"
TOOLS=${BYLINECRM_TOOLS:-/opt/bylinecrm/tools}/$BYLINECRM_ENV
UNITS=${SYSTEMD_UNIT_DIR:-/etc/systemd/system}

mkdir -p "$TOOLS"
install -m 755 "$HERE/backup.sh" "$HERE/restore.sh" "$TOOLS/"
install -m 644 "$HERE/lib.sh" "$TOOLS/"
install -m 644 "$HERE/systemd/bylinecrm-backup@.service" "$HERE/systemd/bylinecrm-backup@.timer" "$UNITS/"
# The offsite remote lives in $BYLINECRM_RUNTIME/backup.env now (#166, bootstrap-secrets.sh), read by
# lib.sh for the unit and a manual run alike. A drop-in from before that is one more place to disagree:
# gone, so the unit sees exactly what a manual run sees.
DROPIN="$UNITS/bylinecrm-backup@$BYLINECRM_ENV.service.d"
if [ -e "$DROPIN/remote.conf" ]; then
    rm -f "$DROPIN/remote.conf"
    rmdir "$DROPIN" 2>/dev/null || true
    echo "install-backup: removed the systemd drop-in $DROPIN/remote.conf — the remote is read from $BYLINECRM_RUNTIME/backup.env" >&2
fi
if [ "${SKIP_SYSTEMCTL:-0}" != 1 ]; then
    systemctl daemon-reload
    systemctl enable --now "bylinecrm-backup@$BYLINECRM_ENV.timer"
    systemctl list-timers "bylinecrm-backup@$BYLINECRM_ENV.timer" --no-pager
fi
echo "install-backup: tools in $TOOLS; timer bylinecrm-backup@$BYLINECRM_ENV.timer (02:47 UTC nightly)" >&2
echo "install-backup: run once by hand and read the output: $TOOLS/backup.sh $BYLINECRM_ENV" >&2
