#!/usr/bin/env bash
# dev-native-db.sh — BylineCRM's local Postgres 16 and Valkey without Docker (D-250, issue #116).
#
#   scripts/dev-native-db.sh setup      create (or repair) both services and start them at login
#   scripts/dev-native-db.sh status     show whether each is installed, running and answering
#   scripts/dev-native-db.sh stop       stop both and stop them starting at login (data kept)
#   scripts/dev-native-db.sh purge      stop, then delete the data directory (asks first)
#
# macOS only (launchd). It runs a Postgres cluster of its OWN — not the Homebrew default cluster another
# project may use on 5432 — and a Valkey, on the same ports as .env.example and docker-compose.yml, both bound
# to 127.0.0.1. Nothing is installed system-wide beyond two LaunchAgents in ~/Library/LaunchAgents.
#
# Needs: Homebrew `postgresql@16` and `valkey` (brew install postgresql@16 valkey).
# Settings (environment, all optional):
#   BYLINECRM_DEV_HOME   data root            (default ~/Library/Application Support/BylineCRM/dev)
#   BYLINECRM_PG_PORT    Postgres port        (default 5441)
#   BYLINECRM_KV_PORT    Valkey port          (default 6391)
# The owner role and database match .env.example (bylinecrm/bylinecrm on database bylinecrm); the restricted
# app role is made afterwards by `pnpm --filter api db:setup`, the one place that role is created.

set -euo pipefail

HOME_DIR=${BYLINECRM_DEV_HOME:-"$HOME/Library/Application Support/BylineCRM/dev"}
PG_PORT=${BYLINECRM_PG_PORT:-5441}
KV_PORT=${BYLINECRM_KV_PORT:-6391}
PG_DATA="$HOME_DIR/postgres16"
KV_DIR="$HOME_DIR/valkey"
LOG_DIR="$HOME_DIR/logs"
AGENTS="$HOME/Library/LaunchAgents"
PG_LABEL=com.bylinecrm.dev.postgres
KV_LABEL=com.bylinecrm.dev.valkey
# Parallel builders each run an API (request + background + owner pools) and a test suite against this server.
PG_MAX_CONNECTIONS=300

die() { echo "dev-native-db: $*" >&2; exit 1; }
say() { echo "dev-native-db: $*" >&2; }

[ "$(uname -s)" = Darwin ] || die "macOS only; elsewhere use docker compose (same ports)"

pg_bin() {
    local prefix
    prefix=$(brew --prefix postgresql@16 2>/dev/null) || die "brew install postgresql@16"
    [ -x "$prefix/bin/postgres" ] || die "brew install postgresql@16"
    printf '%s/bin' "$prefix"
}

kv_bin() {
    local prefix
    prefix=$(brew --prefix valkey 2>/dev/null) || die "brew install valkey"
    [ -x "$prefix/bin/valkey-server" ] || die "brew install valkey"
    printf '%s/bin' "$prefix"
}

# lsof exits 1 when nothing listens; that is the answer "free", not an error.
port_owner() { { lsof -nP -iTCP:"$1" -sTCP:LISTEN 2>/dev/null || true; } | awk 'NR>1 {print $1" (pid "$2")"}' | sort -u | tr '\n' ' '; }

write_agent() { # label, log name, program args...
    local label=$1 log=$2
    shift 2
    local plist="$AGENTS/$label.plist" args=''
    for arg in "$@"; do args+="        <string>${arg}</string>"$'\n'; done
    mkdir -p "$AGENTS"
    cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
${args}    </array>
    <key>EnvironmentVariables</key>
    <dict>
        <!-- launchd starts agents with no locale; postgres then refuses to start ("became multithreaded"). -->
        <key>LC_ALL</key>
        <string>C</string>
    </dict>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardOutPath</key>
    <string>${LOG_DIR}/${log}.log</string>
    <key>StandardErrorPath</key>
    <string>${LOG_DIR}/${log}.log</string>
</dict>
</plist>
EOF
}

load_agent() { # label
    launchctl bootout "gui/$(id -u)/$1" 2>/dev/null || true
    launchctl bootstrap "gui/$(id -u)" "$AGENTS/$1.plist"
}

wait_for() { # description, command...
    local what=$1
    shift
    for _ in $(seq 1 30); do
        "$@" >/dev/null 2>&1 && return 0
        sleep 1
    done
    die "$what did not come up — see $LOG_DIR"
}

setup() {
    local pg kv
    pg=$(pg_bin)
    kv=$(kv_bin)
    mkdir -p "$HOME_DIR" "$KV_DIR" "$LOG_DIR"
    chmod 700 "$HOME_DIR"

    if ! launchctl print "gui/$(id -u)/$PG_LABEL" >/dev/null 2>&1; then
        local owner
        owner=$(port_owner "$PG_PORT")
        [ -z "$owner" ] || die "port $PG_PORT is taken by: $owner — stop it first (docker compose down?)"
    fi
    if ! launchctl print "gui/$(id -u)/$KV_LABEL" >/dev/null 2>&1; then
        local owner
        owner=$(port_owner "$KV_PORT")
        [ -z "$owner" ] || die "port $KV_PORT is taken by: $owner — stop it first (docker compose down?)"
    fi

    if [ ! -f "$PG_DATA/PG_VERSION" ]; then
        say "creating the Postgres 16 cluster in $PG_DATA"
        local pwfile
        pwfile=$(mktemp)
        printf 'bylinecrm\n' >"$pwfile"
        "$pg/initdb" -D "$PG_DATA" -U bylinecrm --pwfile="$pwfile" --auth=scram-sha-256 -E UTF8 --locale=C >/dev/null
        rm -f "$pwfile"
    fi
    write_agent "$PG_LABEL" postgres "$pg/postgres" -D "$PG_DATA" -p "$PG_PORT" \
        -c listen_addresses=127.0.0.1 -c "max_connections=$PG_MAX_CONNECTIONS" -c unix_socket_directories=
    load_agent "$PG_LABEL"
    wait_for "Postgres on $PG_PORT" "$pg/pg_isready" -h 127.0.0.1 -p "$PG_PORT"

    if ! PGPASSWORD=bylinecrm "$pg/psql" -h 127.0.0.1 -p "$PG_PORT" -U bylinecrm -d postgres -tAc \
        "SELECT 1 FROM pg_database WHERE datname = 'bylinecrm'" | grep -q 1; then
        PGPASSWORD=bylinecrm "$pg/createdb" -h 127.0.0.1 -p "$PG_PORT" -U bylinecrm bylinecrm
        say "created database bylinecrm"
    fi

    # Queues only, locally: no persistence, nothing written to disk.
    write_agent "$KV_LABEL" valkey "$kv/valkey-server" --bind 127.0.0.1 --port "$KV_PORT" \
        --save '' --appendonly no --dir "$KV_DIR"
    load_agent "$KV_LABEL"
    wait_for "Valkey on $KV_PORT" "$kv/valkey-cli" -h 127.0.0.1 -p "$KV_PORT" ping

    say "ready: Postgres 16 on 127.0.0.1:$PG_PORT, Valkey on 127.0.0.1:$KV_PORT (both start at login)"
    say "next: pnpm --filter api db:setup   # the restricted role, then migrations"
}

status() {
    local pg kv
    pg=$(pg_bin)
    kv=$(kv_bin)
    for label in "$PG_LABEL" "$KV_LABEL"; do
        if launchctl print "gui/$(id -u)/$label" >/dev/null 2>&1; then
            echo "$label: loaded"
        else
            echo "$label: not loaded"
        fi
    done
    if "$pg/pg_isready" -h 127.0.0.1 -p "$PG_PORT" >/dev/null 2>&1; then
        echo "postgres 127.0.0.1:$PG_PORT: accepting connections"
    else
        echo "postgres 127.0.0.1:$PG_PORT: not answering"
    fi
    if [ "$("$kv/valkey-cli" -h 127.0.0.1 -p "$KV_PORT" ping 2>/dev/null)" = PONG ]; then
        echo "valkey 127.0.0.1:$KV_PORT: PONG ($("$kv/valkey-server" --version | awk '{print $3}'))"
    else
        echo "valkey 127.0.0.1:$KV_PORT: not answering"
    fi
}

stop_all() {
    for label in "$PG_LABEL" "$KV_LABEL"; do
        launchctl bootout "gui/$(id -u)/$label" 2>/dev/null || true
        rm -f "$AGENTS/$label.plist"
    done
    say "stopped; data kept in $HOME_DIR"
}

purge() {
    stop_all
    [ -d "$HOME_DIR" ] || { say "nothing to delete"; return; }
    read -r -p "Delete $HOME_DIR and every local BylineCRM database in it? [y/N] " answer
    [ "$answer" = y ] || { say "kept"; return; }
    rm -rf "$HOME_DIR"
    say "deleted $HOME_DIR"
}

case "${1:-}" in
    setup) setup ;;
    status) status ;;
    stop) stop_all ;;
    purge) purge ;;
    *) die "usage: $0 setup|status|stop|purge" ;;
esac
