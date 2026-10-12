#!/usr/bin/env bash
# backup.sh <env> [--dry-run] — nightly backup of a BylineCRM environment (P5-4c): the database, the
# roles it depends on, and the attachment files; kept locally and copied offsite to R2.
#
# Runs ON the VPS, as root, from the systemd timer bylinecrm-backup@<env>.timer (install-backup.sh)
# or by hand. Touches only $BYLINECRM_BACKUP_DIR and the rclone remote; it reads the environment's
# postgres container and attachment directory and writes nothing there.
#
# Set:   <db>-<stamp>.dump   pg_dump custom format (-Fc: compressed, restorable table by table)
#        roles-<stamp>.sql   pg_dumpall --roles-only — RLS policies name the app role; a database restored
#                            without its roles has policies referencing a user that does not exist
#        attachments-<stamp>.tar.gz
# Each file is written under a .part name and renamed on completion, so a half-written file is never
# mistaken for a good backup.
#
# Retention (local and offsite alike): every daily set for 14 days; Sunday's set for 8 weeks.
#
# Offsite: tonight's set is copied (never synced — a sync would mirror the local sweep) to
# $BYLINECRM_BACKUP_REMOTE/<yyyy>/<mm>/ with rclone, then the same retention is applied there by
# name. If the rclone remote is not configured the local backup still runs and the script says so,
# loudly, in its output and exit code — a missing credential must never turn the job into a no-op.
#
# --dry-run prints what would be done and exits 0 without touching anything.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
bylinecrm_env "${1:?usage: backup.sh <staging|production> [--dry-run]}"
DRY=0
[ "${2:-}" = --dry-run ] && DRY=1

DEST=$BYLINECRM_BACKUP_DIR
REMOTE=$BYLINECRM_BACKUP_REMOTE
RCLONE_CONF=$BYLINECRM_RCLONE_CONF
KEEP_DAILY_DAYS=14
KEEP_WEEKLY_DAYS=56 # 8 weeks of Sunday sets
STAMP=${BACKUP_STAMP:-$(date -u +%Y%m%dT%H%M%SZ)}
ATTACHMENTS="$BYLINECRM_RUNTIME/data/attachments"

log() { echo "backup[$BYLINECRM_ENV]: $*"; }
die() {
    echo "backup[$BYLINECRM_ENV]: FAILED: $*" >&2
    exit 1
}

postgres_container() {
    docker ps -q --filter "label=com.docker.compose.project=$BYLINECRM_PROJECT" \
        --filter "label=com.docker.compose.service=postgres" | head -n 1
}

offsite_configured() {
    [ -s "$RCLONE_CONF" ] && grep -q "^\[${REMOTE%%:*}\]" "$RCLONE_CONF"
}

# Does a set's stamp fall under retention? Daily sets live 14 days; a Sunday set lives 8 weeks.
keep_stamp() { # <stamp like 20261012T024700Z> <now epoch>
    local day=${1:0:8} epoch dow age_days
    epoch=$(date -u -d "${day:0:4}-${day:4:2}-${day:6:2}" +%s 2>/dev/null) ||
        epoch=$(date -u -j -f %Y%m%d "$day" +%s 2>/dev/null) || return 0 # unparsable: keep
    age_days=$(((${2} - epoch) / 86400))
    dow=$(date -u -d "@$epoch" +%u 2>/dev/null || date -u -r "$epoch" +%u)
    [ "$age_days" -le "$KEEP_DAILY_DAYS" ] && return 0
    [ "$dow" = 7 ] && [ "$age_days" -le "$KEEP_WEEKLY_DAYS" ] && return 0
    return 1
}

# The stamps of every complete set in a listing of names (local or remote), oldest first.
stamps_in() { sed -nE 's/^.*-([0-9]{8}T[0-9]{6}Z)\.(dump|sql|tar\.gz)$/\1/p' | sort -u; }

CONTAINER=$(postgres_container)
[ -n "$CONTAINER" ] || die "no running postgres container in project $BYLINECRM_PROJECT"
[ -d "$ATTACHMENTS" ] || die "attachment directory $ATTACHMENTS missing"

if [ "$DRY" = 1 ]; then
    log "dry run — would write to $DEST:"
    log "  bylinecrm-$STAMP.dump, roles-$STAMP.sql, attachments-$STAMP.tar.gz (from container $CONTAINER, $ATTACHMENTS)"
    log "  keep: daily sets for $KEEP_DAILY_DAYS days, Sunday sets for $KEEP_WEEKLY_DAYS days"
    if offsite_configured; then
        log "  offsite: copy to $REMOTE/$(date -u +%Y/%m) and apply the same retention there"
    else
        log "  offsite: NOT CONFIGURED (no [${REMOTE%%:*}] remote in $RCLONE_CONF) — the real run would exit 1 after the local backup"
    fi
    exit 0
fi

umask 077
mkdir -p "$DEST"
PGUSER=$(docker exec "$CONTAINER" printenv POSTGRES_USER)
PGDB=$(docker exec "$CONTAINER" printenv POSTGRES_DB)

write_part() { # <final path> <command...>  — run the command into <path>.part, rename on success
    local final=$1 tmp="$1.part"
    shift
    if "$@" >"$tmp"; then
        mv "$tmp" "$final"
        log "wrote $(basename "$final") ($(du -h "$final" | cut -f1))"
    else
        rm -f "$tmp"
        die "writing $(basename "$final")"
    fi
}

write_part "$DEST/roles-$STAMP.sql" docker exec "$CONTAINER" pg_dumpall -U "$PGUSER" --roles-only
write_part "$DEST/bylinecrm-$STAMP.dump" docker exec "$CONTAINER" pg_dump -U "$PGUSER" -d "$PGDB" -Fc
write_part "$DEST/attachments-$STAMP.tar.gz" tar -C "$ATTACHMENTS" -czf - .

# Local retention, by stamp: a set is kept or removed whole.
now=$(date -u +%s)
for stamp in $(ls -1 "$DEST" 2>/dev/null | stamps_in); do
    keep_stamp "$stamp" "$now" || {
        rm -f "$DEST"/*"-$stamp".*
        log "pruned local set $stamp"
    }
done
find "$DEST" -name '*.part' -mtime +1 -delete
log "local: $(ls -1 "$DEST" | stamps_in | wc -l | tr -d ' ') set(s), $(du -sh "$DEST" | cut -f1)"

# ── offsite ──────────────────────────────────────────────────────────────────────────────────────
if ! offsite_configured; then
    echo "backup[$BYLINECRM_ENV]: OFFSITE NOT CONFIGURED: no [${REMOTE%%:*}] remote in $RCLONE_CONF — local backup only" >&2
    exit 1
fi
month=$(date -u +%Y/%m)
if rclone --config "$RCLONE_CONF" copy "$DEST" "$REMOTE/$month" \
    --include "*-$STAMP.dump" --include "*-$STAMP.sql" --include "*-$STAMP.tar.gz" \
    --transfers 2 --retries 3 --stats-one-line; then
    log "offsite: copied set $STAMP to $REMOTE/$month"
else
    die "OFFSITE COPY FAILED for $STAMP"
fi
# The same retention offsite, by name (never by a sync of the local directory).
for stamp in $(rclone --config "$RCLONE_CONF" lsf -R --files-only "$REMOTE" 2>/dev/null | stamps_in); do
    keep_stamp "$stamp" "$now" || {
        rclone --config "$RCLONE_CONF" delete "$REMOTE" --include "*-$stamp.*" 2>/dev/null || true
        log "pruned offsite set $stamp"
    }
done
log "done"
