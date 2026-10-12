#!/usr/bin/env bash
# restore.sh <env> <stamp> [--into-live] — restore a backup set made by backup.sh (P5-4c).
#
# Runs ON the VPS, as root. By default it restores INTO A SCRATCH DATABASE (`bylinecrm_restore_<stamp>`)
# in the environment's postgres container and unpacks the attachments next to the live ones
# (`data/attachments-restore-<stamp>/`), touching nothing live — that is the restore DRILL, to be run
# periodically (docs/deploy/production.md) and after every change to backup.sh. The scratch database is
# dropped by `restore.sh <env> <stamp> --drop-scratch`.
#
# --into-live replaces the live database and attachments. It stops the api colours first (the web
# answers 502 meanwhile), requires the environment name typed at a terminal, and is never scripted.
# Afterwards deploy the current release again to bring the api back (deploy.sh <env> <sha>).
#
# A set is found locally in $BYLINECRM_BACKUP_DIR; if it is not there it is fetched from the rclone
# remote first.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
bylinecrm_env "${1:?usage: restore.sh <staging|production> <stamp> [--into-live | --drop-scratch]}"
STAMP=${2:?usage: restore.sh <staging|production> <stamp> [--into-live | --drop-scratch]}
MODE=${3:-}

DEST=$BYLINECRM_BACKUP_DIR
REMOTE=$BYLINECRM_BACKUP_REMOTE
RCLONE_CONF=$BYLINECRM_RCLONE_CONF
SCRATCH_DB="bylinecrm_restore_${STAMP//[^0-9A-Za-z]/_}"
SCRATCH_DB=$(printf '%s' "$SCRATCH_DB" | tr 'A-Z' 'a-z')

log() { echo "restore[$BYLINECRM_ENV]: $*"; }
die() {
    echo "restore[$BYLINECRM_ENV]: FAILED: $*" >&2
    exit 1
}
compose() {
    docker compose -p "$BYLINECRM_PROJECT" --profile blue --profile green --profile tools \
        -f "$HERE/docker-compose.yml" "$@"
}

CONTAINER=$(docker ps -q --filter "label=com.docker.compose.project=$BYLINECRM_PROJECT" \
    --filter "label=com.docker.compose.service=postgres" | head -n 1)
[ -n "$CONTAINER" ] || die "no running postgres container in project $BYLINECRM_PROJECT"
PGUSER=$(docker exec "$CONTAINER" printenv POSTGRES_USER)
PGDB=$(docker exec "$CONTAINER" printenv POSTGRES_DB)
psql_db() { docker exec -i "$CONTAINER" psql -U "$PGUSER" -d postgres -v ON_ERROR_STOP=1 -qAt "$@"; }

if [ "$MODE" = --drop-scratch ]; then
    psql_db -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\""
    rm -rf "$BYLINECRM_RUNTIME/data/attachments-restore-$STAMP"
    log "dropped $SCRATCH_DB and data/attachments-restore-$STAMP"
    exit 0
fi

DUMP="$DEST/bylinecrm-$STAMP.dump"
ROLES="$DEST/roles-$STAMP.sql"
ATT="$DEST/attachments-$STAMP.tar.gz"
if [ ! -f "$DUMP" ] || [ ! -f "$ROLES" ] || [ ! -f "$ATT" ]; then
    log "set $STAMP is not complete locally — fetching from $REMOTE"
    [ -s "$RCLONE_CONF" ] || die "no rclone config at $RCLONE_CONF and the set is not local"
    mkdir -p "$DEST"
    rclone --config "$RCLONE_CONF" copy "$REMOTE" "$DEST" --include "*-$STAMP.*" --stats-one-line
    [ -f "$DUMP" ] && [ -f "$ROLES" ] && [ -f "$ATT" ] || die "set $STAMP not found offsite either"
fi
log "set $STAMP: $(du -h "$DUMP" | cut -f1) dump, $(du -h "$ATT" | cut -f1) attachments"

# Roles first: the dump's RLS policies and grants name bylinecrm_app. Existing roles are left alone
# (CREATE ROLE of an existing role is an error psql reports and continues past).
docker exec -i "$CONTAINER" psql -U "$PGUSER" -d postgres -q <"$ROLES" >/dev/null 2>&1 || true

if [ "$MODE" = --into-live ]; then
    [ -t 0 ] || die "--into-live needs the environment name typed at a terminal"
    printf 'restore: this REPLACES the live %s database and attachments with set %s. Type "%s" to continue: ' \
        "$BYLINECRM_ENV" "$STAMP" "$BYLINECRM_ENV" >&2
    IFS= read -r typed
    [ "$typed" = "$BYLINECRM_ENV" ] || die "not confirmed; nothing changed"
    log "stopping the api colours (the site answers 502 until the next deploy)"
    compose stop api-blue api-green >/dev/null 2>&1 || true
    psql_db -c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = '$PGDB' AND pid <> pg_backend_pid()" >/dev/null
    psql_db -c "DROP DATABASE IF EXISTS \"$PGDB\""
    psql_db -c "CREATE DATABASE \"$PGDB\" OWNER \"$PGUSER\""
    docker exec -i "$CONTAINER" pg_restore -U "$PGUSER" -d "$PGDB" --no-owner --role="$PGUSER" <"$DUMP"
    live="$BYLINECRM_RUNTIME/data/attachments"
    stage=$(mktemp -d "$BYLINECRM_RUNTIME/data/.attachments-restore.XXXXXX")
    tar -C "$stage" -xzf "$ATT"
    chown -R 1000:1000 "$stage"
    mv "$live" "$live.replaced-$(date -u +%Y%m%dT%H%M%SZ)"
    mv "$stage" "$live"
    log "live database and attachments replaced from set $STAMP; the previous attachments are kept beside them"
    log "now deploy the current release to bring the api back: deploy.sh $BYLINECRM_ENV \$(cat $BYLINECRM_RUNTIME/DEPLOYED_SHA)"
    exit 0
fi

# The drill: a scratch database and a scratch attachment directory, nothing live touched.
psql_db -c "DROP DATABASE IF EXISTS \"$SCRATCH_DB\""
psql_db -c "CREATE DATABASE \"$SCRATCH_DB\" OWNER \"$PGUSER\""
docker exec -i "$CONTAINER" pg_restore -U "$PGUSER" -d "$SCRATCH_DB" --no-owner --role="$PGUSER" <"$DUMP"
scratch_att="$BYLINECRM_RUNTIME/data/attachments-restore-$STAMP"
rm -rf "$scratch_att"
mkdir -p "$scratch_att"
tar -C "$scratch_att" -xzf "$ATT"
tables=$(docker exec "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH_DB" -qAt -c "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'")
people=$(docker exec "$CONTAINER" psql -U "$PGUSER" -d "$SCRATCH_DB" -qAt -c "SELECT count(*) FROM people" 2>/dev/null || echo '?')
log "restored into $SCRATCH_DB: $tables tables, $people people; attachments in $scratch_att ($(find "$scratch_att" -type f | wc -l | tr -d ' ') files)"
log "drill done — compare with the live counts, then: restore.sh $BYLINECRM_ENV $STAMP --drop-scratch"
