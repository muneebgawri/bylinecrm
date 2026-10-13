#!/usr/bin/env bash
# backup-env.test.sh — the offsite remote comes from a per-environment runtime file, not a systemd
# drop-in (#166): lib.sh reads $BYLINECRM_RUNTIME/backup.env (a caller's value still wins; no file
# means the defaults), bootstrap-secrets.sh writes it from BYLINECRM_BACKUP_REMOTE and keeps it on a
# re-run, backup.sh copies to the remote it names, and install-backup.sh removes a leftover drop-in.
#
# Runs the real scripts against a temporary directory with a fake docker/rclone. No docker, root,
# systemd or network.
#
# Usage: bash deploy/env/test/backup-env.test.sh

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
ENV_DIR="$HERE/.."
failures=0
fail() {
    echo "FAIL: $*" >&2
    failures=$((failures + 1))
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
RUNTIME="$WORK/runtime"
mkdir -p "$RUNTIME"

# ── lib.sh: no file → the defaults; the file → its values; a caller's value → wins over the file. ──
read_env() {
    (
        unset BYLINECRM_BACKUP_REMOTE BYLINECRM_RCLONE_CONF
        # shellcheck source=../lib.sh
        . "$ENV_DIR/lib.sh"
        BYLINECRM_RUNTIME="$RUNTIME" bylinecrm_env production
        echo "$BYLINECRM_BACKUP_REMOTE|$BYLINECRM_RCLONE_CONF"
    )
}
[ "$(read_env)" = "r2:bylinecrm-backups/production|/root/.config/rclone/rclone.conf" ] ||
    fail "without backup.env the defaults should apply: $(read_env)"
printf 'BYLINECRM_BACKUP_REMOTE=r2-bylinecrm:bylinecrm-backups/production\nBYLINECRM_RCLONE_CONF=/opt/bylinecrm-production-runtime/rclone.conf\n' >"$RUNTIME/backup.env"
[ "$(read_env)" = "r2-bylinecrm:bylinecrm-backups/production|/opt/bylinecrm-production-runtime/rclone.conf" ] ||
    fail "backup.env should set the remote and the rclone config: $(read_env)"
caller=$(
    # shellcheck source=../lib.sh
    . "$ENV_DIR/lib.sh"
    BYLINECRM_RUNTIME="$RUNTIME" BYLINECRM_BACKUP_REMOTE="caller:wins" bylinecrm_env production
    echo "$BYLINECRM_BACKUP_REMOTE|$BYLINECRM_RCLONE_CONF"
)
[ "$caller" = "caller:wins|/opt/bylinecrm-production-runtime/rclone.conf" ] || fail "a caller's remote should win over the file: $caller"
# A line that is not one of the two keys is never read (the file is data, not a script).
printf 'BYLINECRM_BACKUP_REMOTE=r2-bylinecrm:bylinecrm-backups/production\nBYLINECRM_RUNTIME=/elsewhere\nrm -rf /\n' >"$RUNTIME/backup.env"
[ "$(read_env)" = "r2-bylinecrm:bylinecrm-backups/production|/root/.config/rclone/rclone.conf" ] ||
    fail "only the two backup keys should be read: $(read_env)"

# ── bootstrap-secrets.sh writes backup.env from BYLINECRM_BACKUP_REMOTE, 0600, and keeps it on a re-run. ──
rm -f "$RUNTIME/backup.env"
bootstrap() {
    BYLINECRM_RUNTIME="$RUNTIME" BYLINECRM_API_UID="$(id -u)" BYLINECRM_API_GID="$(id -g)" \
        bash "$ENV_DIR/bootstrap-secrets.sh" production "$@" 2>&1
}
out=$(bootstrap) || fail "bootstrap without a remote failed: $out"
[ -e "$RUNTIME/backup.env" ] && fail "bootstrap wrote backup.env with nothing to say"
out=$(BYLINECRM_BACKUP_REMOTE="r2-bylinecrm:bylinecrm-backups/production" bootstrap) || fail "bootstrap with a remote failed: $out"
grep -qx 'BYLINECRM_BACKUP_REMOTE=r2-bylinecrm:bylinecrm-backups/production' "$RUNTIME/backup.env" 2>/dev/null ||
    fail "bootstrap did not write the remote to backup.env"
[ "$(stat -c %a "$RUNTIME/backup.env" 2>/dev/null || stat -f %Lp "$RUNTIME/backup.env")" = 600 ] || fail "backup.env is not 0600"
grep -q 'BYLINECRM_BACKUP_REMOTE' "$RUNTIME/production.env" && fail "the remote leaked into the app env"
out=$(bootstrap) || fail "bootstrap re-run failed: $out"
grep -qx 'BYLINECRM_BACKUP_REMOTE=r2-bylinecrm:bylinecrm-backups/production' "$RUNTIME/backup.env" ||
    fail "a re-run without the variable dropped the remote"
grep -q 'kept existing BYLINECRM_BACKUP_REMOTE' <<<"$out" || fail "a re-run should say it kept the remote"
out=$(BYLINECRM_RCLONE_CONF="$RUNTIME/rclone.conf" bootstrap) || fail "bootstrap with an rclone config failed: $out"
grep -qx "BYLINECRM_RCLONE_CONF=$RUNTIME/rclone.conf" "$RUNTIME/backup.env" || fail "the rclone config was not written"
grep -qx 'BYLINECRM_BACKUP_REMOTE=r2-bylinecrm:bylinecrm-backups/production' "$RUNTIME/backup.env" ||
    fail "writing the rclone config dropped the remote"

# ── backup.sh, run as the unit runs it (no variables), copies to the remote backup.env names. ──
mkdir -p "$WORK/bin" "$RUNTIME/data/attachments" "$WORK/backups"
echo hello >"$RUNTIME/data/attachments/a.txt"
printf '[r2-bylinecrm]\ntype = s3\n' >"$RUNTIME/rclone.conf"
CALLS="$WORK/calls"
: >"$CALLS"
cat >"$WORK/bin/docker" <<EOS
#!/usr/bin/env bash
echo "\$*" >>"$CALLS"
case "\$*" in
    "ps -q --filter label=com.docker.compose.project=bylinecrm-production --filter label=com.docker.compose.service=postgres") echo pg0 ;;
    "exec pg0 printenv POSTGRES_USER") echo bylinecrm ;;
    "exec pg0 printenv POSTGRES_DB") echo bylinecrm ;;
    *"pg_dumpall"*) echo "CREATE ROLE bylinecrm_app;" ;;
    *"pg_dump "*) printf 'PGDMP' ;;
esac
exit 0
EOS
cat >"$WORK/bin/rclone" <<EOS
#!/usr/bin/env bash
echo "\$*" >>"$CALLS"
exit 0
EOS
chmod +x "$WORK/bin/docker" "$WORK/bin/rclone"
set +e
out=$(PATH="$WORK/bin:$PATH" BYLINECRM_RUNTIME="$RUNTIME" BYLINECRM_BACKUP_DIR="$WORK/backups" BACKUP_STAMP=20991231T000000Z \
    bash "$ENV_DIR/backup.sh" production 2>&1)
status=$?
set -e
[ "$status" -eq 0 ] || fail "backup.sh with backup.env exited $status: $out"
grep -q "config $RUNTIME/rclone.conf copy .* r2-bylinecrm:bylinecrm-backups/production/" "$CALLS" ||
    fail "backup.sh did not copy to the remote backup.env names: $(cat "$CALLS")"

# ── install-backup.sh removes a leftover drop-in, so the unit and a manual run agree. ──
UNITS="$WORK/units"
mkdir -p "$UNITS/bylinecrm-backup@production.service.d"
echo '[Service]' >"$UNITS/bylinecrm-backup@production.service.d/remote.conf"
out=$(SYSTEMD_UNIT_DIR="$UNITS" SKIP_SYSTEMCTL=1 BYLINECRM_TOOLS="$WORK/tools" bash "$ENV_DIR/install-backup.sh" production 2>&1) ||
    fail "install-backup failed: $out"
[ -e "$UNITS/bylinecrm-backup@production.service.d/remote.conf" ] && fail "the drop-in was left in place"
[ -e "$UNITS/bylinecrm-backup@production.service.d" ] && fail "the empty drop-in directory was left in place"
grep -q 'removed the systemd drop-in' <<<"$out" || fail "install-backup did not say it removed the drop-in"
[ -f "$UNITS/bylinecrm-backup@.service" ] || fail "the unit was not installed"

if [ "$failures" -eq 0 ]; then
    echo "backup-env: all checks passed"
else
    echo "backup-env: $failures check(s) failed" >&2
    exit 1
fi
