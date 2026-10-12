#!/usr/bin/env bash
# backup.test.sh — backup.sh writes a complete set under .part-then-rename, applies 14-daily /
# 8-weekly retention locally and offsite, copies only tonight's set, and is loud (exit 1) when offsite
# is not configured; --dry-run touches nothing (P5-4c).
#
# Runs the real backup.sh with fake `docker` and `rclone` first on PATH. No docker, root or network.
#
# Usage: bash deploy/env/test/backup.test.sh

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
BACKUP="$HERE/../backup.sh"
failures=0
fail() {
    echo "FAIL: $*" >&2
    failures=$((failures + 1))
}

# A stamp N days ago (UTC midnight) — GNU and BSD date.
stamp_days_ago() {
    local epoch=$(($(date -u +%s) - $1 * 86400))
    date -u -d "@$epoch" +%Y%m%dT000000Z 2>/dev/null || date -u -r "$epoch" +%Y%m%dT000000Z
}
dow_days_ago() {
    local epoch=$(($(date -u +%s) - $1 * 86400))
    date -u -d "@$epoch" +%u 2>/dev/null || date -u -r "$epoch" +%u
}
# A Sunday and a non-Sunday, both 15–21 days ago (past the daily window, inside the weekly one).
for d in $(seq 15 21); do
    if [ "$(dow_days_ago "$d")" = 7 ]; then OLD_SUNDAY=$(stamp_days_ago "$d"); else OLD_WEEKDAY=$(stamp_days_ago "$d"); fi
done
ANCIENT_SUNDAY=$(stamp_days_ago $((21 + 7 * 8))) # a Sunday past the 8-week window, give or take: same weekday as OLD_SUNDAY
while [ "$(date -u -d "${ANCIENT_SUNDAY:0:4}-${ANCIENT_SUNDAY:4:2}-${ANCIENT_SUNDAY:6:2}" +%u 2>/dev/null || date -u -j -f %Y%m%d "${ANCIENT_SUNDAY:0:8}" +%u)" != 7 ]; do
    ANCIENT_SUNDAY=$(stamp_days_ago $(( ($(date -u +%s) - $(date -u -d "${ANCIENT_SUNDAY:0:4}-${ANCIENT_SUNDAY:4:2}-${ANCIENT_SUNDAY:6:2}" +%s 2>/dev/null || date -u -j -f %Y%m%d "${ANCIENT_SUNDAY:0:8}" +%s)) / 86400 + 1 )))
done
RECENT=$(stamp_days_ago 3)

# scenario <offsite: yes|no> [--dry-run] → $WORK, $STATUS, $OUT, $CALLS, $DEST
scenario() {
    local offsite=$1 mode=${2:-}
    WORK=$(mktemp -d)
    mkdir -p "$WORK/bin" "$WORK/runtime/data/attachments" "$WORK/backups" "$WORK/rclone"
    echo hello >"$WORK/runtime/data/attachments/a.txt"
    DEST="$WORK/backups"
    CALLS="$WORK/calls"
    : >"$CALLS"
    # Existing sets: a recent one, an old weekday, an old Sunday, an ancient Sunday.
    for s in "$RECENT" "$OLD_WEEKDAY" "$OLD_SUNDAY" "$ANCIENT_SUNDAY"; do
        for f in "bylinecrm-$s.dump" "roles-$s.sql" "attachments-$s.tar.gz"; do echo x >"$DEST/$f"; done
    done
    echo x >"$DEST/bylinecrm-stale.dump.part"
    touch -t "$(date -u -d '@'$(($(date -u +%s) - 3 * 86400)) +%Y%m%d%H%M 2>/dev/null || date -u -r $(($(date -u +%s) - 3 * 86400)) +%Y%m%d%H%M)" "$DEST/bylinecrm-stale.dump.part"
    [ "$offsite" = yes ] && printf '[r2]\ntype = s3\n' >"$WORK/rclone/rclone.conf"
    cat >"$WORK/bin/docker" <<EOF
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
EOF
    cat >"$WORK/bin/rclone" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$CALLS"
case "\$*" in
    *" lsf -R --files-only "*) printf '2026/01/bylinecrm-%s.dump\n2026/01/attachments-%s.tar.gz\n' "$OLD_WEEKDAY" "$OLD_SUNDAY" ;;
esac
exit 0
EOF
    chmod +x "$WORK/bin/docker" "$WORK/bin/rclone"
    set +e
    OUT=$(PATH="$WORK/bin:$PATH" BYLINECRM_RUNTIME="$WORK/runtime" BYLINECRM_BACKUP_DIR="$DEST" \
        BYLINECRM_RCLONE_CONF="$WORK/rclone/rclone.conf" BYLINECRM_BACKUP_REMOTE="r2:bylinecrm-backups/production" \
        BACKUP_STAMP=20991231T000000Z bash "$BACKUP" production $mode 2>&1)
    STATUS=$?
    set -e
}

# ── Dry run: a plan, nothing written. ──
scenario no --dry-run
[ "$STATUS" -eq 0 ] || fail "dry run exited $STATUS: $OUT"
grep -q 'dry run' <<<"$OUT" || fail "dry run not announced"
grep -q 'NOT CONFIGURED' <<<"$OUT" || fail "dry run did not warn about offsite"
[ -f "$DEST/bylinecrm-20991231T000000Z.dump" ] && fail "dry run wrote a dump"
[ -f "$DEST/bylinecrm-$OLD_WEEKDAY.dump" ] || fail "dry run pruned"
rm -rf "$WORK"

# ── No offsite remote: the local set is written, retention applied, exit 1 and loud. ──
scenario no
[ "$STATUS" -eq 1 ] || fail "run without offsite exited $STATUS (want 1): $OUT"
grep -q 'OFFSITE NOT CONFIGURED' <<<"$OUT" || fail "missing offsite not reported"
for f in bylinecrm-20991231T000000Z.dump roles-20991231T000000Z.sql attachments-20991231T000000Z.tar.gz; do
    [ -s "$DEST/$f" ] || fail "$f not written"
done
[ "$(cat "$DEST/bylinecrm-20991231T000000Z.dump")" = PGDMP ] || fail "dump content not the pg_dump output"
tar -tzf "$DEST/attachments-20991231T000000Z.tar.gz" | grep -q 'a.txt' || fail "attachments tar lacks the file"
ls "$DEST" | grep -q '\.part$' && fail "a .part file was left behind"
[ -f "$DEST/bylinecrm-$RECENT.dump" ] || fail "recent set pruned"
[ -f "$DEST/bylinecrm-$OLD_SUNDAY.dump" ] || fail "old Sunday set pruned (should be kept 8 weeks)"
[ -f "$DEST/bylinecrm-$OLD_WEEKDAY.dump" ] && fail "old weekday set kept past 14 days"
[ -f "$DEST/roles-$OLD_WEEKDAY.sql" ] && fail "old weekday roles kept past 14 days"
[ -f "$DEST/bylinecrm-$ANCIENT_SUNDAY.dump" ] && fail "ancient Sunday set kept past 8 weeks"
grep -q '^rclone' "$CALLS" && fail "rclone called without a remote configured"
rm -rf "$WORK"

# ── Offsite configured: tonight's set copied by name, remote retention by name. ──
scenario yes
[ "$STATUS" -eq 0 ] || fail "run with offsite exited $STATUS: $OUT"
grep -q 'copy .* r2:bylinecrm-backups/production/[0-9]\{4\}/[0-9]\{2\} --include \*-20991231T000000Z.dump' "$CALLS" || fail "tonight's set not copied by name"
grep -q 'sync ' "$CALLS" && fail "used sync (would mirror the local sweep)"
grep -q "delete r2:bylinecrm-backups/production --include \*-$OLD_WEEKDAY\.\*" "$CALLS" || fail "old weekday set not pruned offsite"
grep -q "delete r2:bylinecrm-backups/production --include \*-$OLD_SUNDAY\.\*" "$CALLS" && fail "old Sunday set pruned offsite"
rm -rf "$WORK"

if [ "$failures" -eq 0 ]; then
    echo "backup: all checks passed"
else
    echo "backup: $failures check(s) failed" >&2
    exit 1
fi
