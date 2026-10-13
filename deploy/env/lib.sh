#!/usr/bin/env bash
# lib.sh — the one table of BylineCRM's deployed environments (P5-4c), sourced by every script in
# deploy/env/. Nothing else in the repository knows an environment's name, URL, directory or cap.
#
#   source "$(dirname "$0")/lib.sh"; bylinecrm_env "$1"      # then use the BYLINECRM_* variables
#
# Both environments run on the NewswireOS production VPS beside NewswireOS, from the same images, with
# the same scripts; only this table differs. A value already set in the caller's environment wins
# (that is how the tests point everything at a temporary directory) — except the name itself.

bylinecrm_env() {
    local env=${1:-}
    case "$env" in
        staging)
            # Staging predates this table and keeps the directory it was created with: moving a live
            # stack's data for a tidier name is risk with no return (the compose project, the data and
            # the edge file stay where NewswireOS's runbooks and the owner already know them).
            : "${BYLINECRM_RUNTIME:=/opt/bylinecrm-runtime}"
            : "${BYLINECRM_PUBLIC_HOST:=staging.crm.pinionnewswire.com}"
            : "${BYLINECRM_API_MEM:=768m}"
            : "${BYLINECRM_POSTGRES_MEM:=512m}"
            : "${BYLINECRM_VALKEY_MEM:=128m}"
            : "${BYLINECRM_VALKEY_MAXMEMORY:=96mb}"
            : "${BYLINECRM_WEB_MEM:=64m}"
            ;;
        production)
            : "${BYLINECRM_RUNTIME:=/opt/bylinecrm-production-runtime}"
            : "${BYLINECRM_PUBLIC_HOST:=crm.pinionnewswire.com}"
            : "${BYLINECRM_API_MEM:=1g}"
            : "${BYLINECRM_POSTGRES_MEM:=1g}"
            : "${BYLINECRM_VALKEY_MEM:=192m}"
            : "${BYLINECRM_VALKEY_MAXMEMORY:=160mb}"
            : "${BYLINECRM_WEB_MEM:=64m}"
            ;;
        *)
            echo "bylinecrm: unknown environment '${env}' (staging | production)" >&2
            return 2
            ;;
    esac
    BYLINECRM_ENV=$env
    BYLINECRM_PROJECT="bylinecrm-$env"
    : "${BYLINECRM_PUBLIC_URL:=https://$BYLINECRM_PUBLIC_HOST}"
    : "${BYLINECRM_RELEASES:=/opt/bylinecrm/releases}"
    : "${BYLINECRM_MIGRATE_MEM:=384m}"
    # The include file this environment owns on the NewswireOS edge, and the alias prefix its web
    # colours carry on the shared `bylinecrm-edge` network (the edge names the live colour; both
    # environments share that network, so every alias carries the environment).
    BYLINECRM_EDGE_CONF="bylinecrm-$env.conf"
    BYLINECRM_WEB_ALIAS="bylinecrm-$env-web"
    # The application's env file: staging keeps its historical name, so the pattern is <env>.env.
    BYLINECRM_APP_ENV="$BYLINECRM_RUNTIME/$env.env"
    BYLINECRM_PG_ENV="$BYLINECRM_RUNTIME/postgres.env"
    # Backups (backup.sh): local copies, and the rclone remote the offsite copy goes to. The remote
    # and the rclone config may be set per environment in $BYLINECRM_RUNTIME/backup.env (#166),
    # written by bootstrap-secrets.sh — one file the unit and a manual run both read, no systemd
    # drop-in. A caller's value still wins; the defaults apply where neither says.
    : "${BYLINECRM_BACKUP_DIR:=/var/backups/bylinecrm-$env}"
    bylinecrm_read_backup_env "$BYLINECRM_RUNTIME/backup.env"
    : "${BYLINECRM_BACKUP_REMOTE:=r2:bylinecrm-backups/$env}"
    : "${BYLINECRM_RCLONE_CONF:=/root/.config/rclone/rclone.conf}"
    export BYLINECRM_ENV BYLINECRM_PROJECT BYLINECRM_RUNTIME BYLINECRM_PUBLIC_HOST BYLINECRM_PUBLIC_URL \
        BYLINECRM_RELEASES BYLINECRM_API_MEM BYLINECRM_POSTGRES_MEM BYLINECRM_VALKEY_MEM \
        BYLINECRM_VALKEY_MAXMEMORY BYLINECRM_WEB_MEM BYLINECRM_MIGRATE_MEM BYLINECRM_EDGE_CONF \
        BYLINECRM_WEB_ALIAS BYLINECRM_APP_ENV BYLINECRM_PG_ENV BYLINECRM_BACKUP_DIR \
        BYLINECRM_BACKUP_REMOTE BYLINECRM_RCLONE_CONF
}

# Reads BYLINECRM_BACKUP_REMOTE and BYLINECRM_RCLONE_CONF from the environment's backup.env (#166)
# where the caller has not set them. The file is data, not a script: only those two keys are read,
# by name, and nothing in it is executed.
bylinecrm_read_backup_env() {
    local file=$1 key value
    [ -f "$file" ] || return 0
    for key in BYLINECRM_BACKUP_REMOTE BYLINECRM_RCLONE_CONF; do
        [ -z "${!key:-}" ] || continue
        value=$(sed -n "s/^${key}=//p" "$file" | head -n 1)
        [ -n "$value" ] && printf -v "$key" '%s' "$value"
    done
    return 0
}

# Every environment, for the few places that look across them (release pruning keeps each one's
# recent releases; the backup timer is installed per environment).
BYLINECRM_ENVS="staging production"

# The two colours a release alternates between. `bylinecrm_other_colour blue` → green.
bylinecrm_other_colour() {
    case "$1" in
        blue) echo green ;;
        green) echo blue ;;
        *) echo blue ;;
    esac
}

# The colour serving this environment now, or `none` before the first blue/green release.
bylinecrm_active_colour() {
    local file="$BYLINECRM_RUNTIME/ACTIVE_COLOUR"
    if [ -s "$file" ]; then cat "$file"; else echo none; fi
}
