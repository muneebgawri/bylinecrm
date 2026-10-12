#!/usr/bin/env bash
# release-preflight.test.sh — release-remote.sh, for both environments:
#   • refuses before migrating when the environment would not boot the new image (#120), and says
#     which environment's file and install command;
#   • on a passing check releases blue/green in order (P5-4c): pull → check → migrate → the idle api
#     colour up and healthy → web upstream pointed at it → the idle web colour up and serving → the
#     edge rendered for that colour and reloaded → the old colour stopped → ACTIVE_COLOUR recorded;
#   • reverts (web upstream back, new colour removed, old colour never stopped) when the new api
#     never becomes healthy or the edge refuses the rendered file.
#
# Runs the real release-remote.sh, bootstrap-secrets.sh and install-edge.sh against a temporary
# runtime directory, with a fake `docker` first on PATH that records every call and answers as the
# scenario says. What check-env itself decides is covered by apps/api/src/cli/check-env.spec.ts.
# No docker, root or network needed.
#
# Usage: bash deploy/env/test/release-preflight.test.sh

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RELEASE="$HERE/../release-remote.sh"
SHA=0000000000000000000000000000000000000120
failures=0

fail() {
    echo "FAIL: $*" >&2
    failures=$((failures + 1))
}

# scenario <env> <check-env exit> <check-env stdout> [api-health exit] [edge-test mode] [active colour]
#   edge-test mode: '' (no edge file), https (file present, nginx -t passes), https-refuse (nginx -t
#   fails whenever the file names web-green). Sets $WORK, $STATUS, $OUT, $CALLS, $DYN.
scenario() {
    local env=$1 check_exit=$2 check_out=$3 api_exit=${4:-0} edge=${5:-} active=${6:-}
    WORK=$(mktemp -d)
    mkdir -p "$WORK/bin" "$WORK/runtime" "$WORK/releases" "$WORK/dyn"
    CALLS="$WORK/calls"
    DYN="$WORK/dyn"
    : >"$CALLS"
    printf '%s' "$check_out" >"$WORK/check.out"
    [ -n "$active" ] && echo "$active" >"$WORK/runtime/ACTIVE_COLOUR"
    case "$edge" in
        https | https-refuse)
            printf 'listen 443 ssl;\nset $bylinecrm_web http://bylinecrm-%s-web-%s:80;\n' "$env" "${active:-blue}" >"$DYN/bylinecrm-$env.conf"
            ;;
    esac
    cat >"$WORK/bin/docker" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$CALLS"
case "\$*" in
    *"run --rm --no-deps -T migrate node dist/cli/check-env.js"*)
        echo " Container bylinecrm-$env-migrate-run-1 Creating" >&2
        cat "$WORK/check.out"
        exit $check_exit ;;
    *"exec -T api-"*"node -e"*) exit $api_exit ;;
    *"exec newswireos-web-1 nginx -t"*)
        if [ "$edge" = https-refuse ] && grep -q web-green "$DYN/bylinecrm-$env.conf" 2>/dev/null; then exit 1; fi
        exit 0 ;;
    "ps -q --filter label=com.docker.compose.project=bylinecrm-$env --filter label=com.docker.compose.service=web-${active:-none}")
        echo oldweb0 ;;
    "ps "*) ;;
esac
exit 0
EOF
    chmod +x "$WORK/bin/docker"
    set +e
    OUT=$(PATH="$WORK/bin:$PATH" BYLINECRM_RUNTIME="$WORK/runtime" BYLINECRM_RELEASES="$WORK/releases" \
        BYLINECRM_API_UID="$(id -u)" BYLINECRM_API_GID="$(id -g)" DYNAMIC_DIR="$DYN" EDGE_CONF_DIR="$HERE/.." \
        NEWSWIREOS_LOCK="$WORK/no-such-lock" HEALTH_TRIES=1 DRAIN_SECONDS=0 \
        bash "$RELEASE" "$env" "$SHA" 2>&1)
    STATUS=$?
    set -e
}
line_of() { grep -nE -- "$1" "$CALLS" | head -n 1 | cut -d: -f1; }

for env in staging production; do
    # ── The release a new required variable would have broken (2026-10-11: MAIL_FROM). ──
    scenario "$env" 1 $'MAIL_FROM: required when NODE_ENV=production (transactional mail, #93)\nRESEND_API_KEY: required when NODE_ENV=production (transactional mail, #93)'
    [ "$STATUS" -ne 0 ] || fail "$env: refusing release exited 0"
    grep -q "$WORK/runtime/$env.env does not boot this release — nothing was changed" <<<"$OUT" || fail "$env: refusal not explained with the environment's file"
    grep -q '  MAIL_FROM: required when NODE_ENV=production' <<<"$OUT" || fail "$env: MAIL_FROM not named"
    grep -q "install-resend-key.sh $env" <<<"$OUT" || fail "$env: no install command naming the environment"
    grep -q 'Container bylinecrm-' <<<"$OUT" && fail "$env: compose progress shown as a problem"
    grep -q 'run --rm migrate' "$CALLS" && fail "$env: migrated despite the refusal"
    grep -q ' up ' "$CALLS" && fail "$env: started a service despite the refusal"
    [ -f "$WORK/runtime/DEPLOYED_SHA" ] && fail "$env: recorded DEPLOYED_SHA despite the refusal"
    [ -d "$WORK/runtime/deploy.lock" ] && fail "$env: left the deploy lock behind"
    grep -q '^MAIL_FROM=' "$WORK/runtime/$env.env" || fail "$env: bootstrap-secrets did not write the release's environment"
    grep -q "^APP_URL=https://$([ "$env" = production ] && echo crm || echo staging.crm).pinionnewswire.com$" "$WORK/runtime/$env.env" ||
        fail "$env: APP_URL is not the environment's URL"
    grep -q -- "-p bylinecrm-$env " "$CALLS" || fail "$env: compose not addressed by the environment's project"
    rm -rf "$WORK"

    # ── The check cannot run at all (no output): say so, show docker's own error, refuse. ──
    scenario "$env" 125 ''
    [ "$STATUS" -ne 0 ] || fail "$env: release went ahead when the check could not run"
    grep -q 'the environment check could not run' <<<"$OUT" || fail "$env: unrunnable check not reported"
    grep -q 'run --rm migrate' "$CALLS" && fail "$env: migrated when the check could not run"
    rm -rf "$WORK"
done

# ── First release of an environment (no colour yet): blue, in order, nothing to drain. ──
scenario staging 0 '' 0 https
[ "$STATUS" -eq 0 ] || fail "first release exited $STATUS: $OUT"
pull=$(line_of 'pull --quiet'); check=$(line_of 'check-env\.js'); migrate=$(line_of 'run --rm migrate')
api_up=$(line_of 'up -d --no-deps api-blue'); api_ok=$(line_of 'exec -T api-blue node -e')
web_up=$(line_of 'up -d --no-deps web-blue'); web_ok=$(line_of 'exec -T web-blue sh -c')
edge=$(line_of 'exec newswireos-web-1 nginx -s reload')
{ [ -n "$edge" ] && [ "$pull" -lt "$check" ] && [ "$check" -lt "$migrate" ] && [ "$migrate" -lt "$api_up" ] &&
    [ "$api_up" -lt "$api_ok" ] && [ "$api_ok" -lt "$web_up" ] && [ "$web_up" -lt "$web_ok" ] && [ "$web_ok" -lt "$edge" ]; } ||
    fail "first release out of order: pull=$pull check=$check migrate=$migrate api_up=$api_up api_ok=$api_ok web_up=$web_up web_ok=$web_ok edge=$edge"
grep -q 'server api-blue:3000' "$WORK/runtime/web-dynamic/api-upstream.conf" || fail "web upstream does not name api-blue"
grep -q 'bylinecrm-staging-web-blue:80' "$DYN/bylinecrm-staging.conf" || fail "edge file does not name the blue web colour"
grep -q 'server_name staging.crm.pinionnewswire.com' "$DYN/bylinecrm-staging.conf" || fail "edge file does not name the host"
grep -q ' stop ' "$CALLS" && fail "first release stopped something"
[ "$(cat "$WORK/runtime/ACTIVE_COLOUR")" = blue ] || fail "ACTIVE_COLOUR not blue"
[ "$(cat "$WORK/runtime/DEPLOYED_SHA")" = "$SHA" ] || fail "DEPLOYED_SHA not recorded"
[ -d "$WORK/runtime/deploy.lock" ] && fail "lock left behind after a release"
rm -rf "$WORK"

# ── Second release: green comes up, is pointed at and switched to, then blue drains and stops. ──
scenario production 0 '' 0 https blue
echo 0000000000000000000000000000000000000119 >"$WORK/runtime/DEPLOYED_SHA.was" # (documentation only)
[ "$STATUS" -eq 0 ] || fail "second release exited $STATUS: $OUT"
green_ok=$(line_of 'exec -T web-green sh -c'); edge=$(line_of 'exec newswireos-web-1 nginx -s reload')
stop=$(line_of ' stop web-blue api-blue'); reload_old=$(line_of 'exec oldweb0 sh -c')
{ [ -n "$stop" ] && [ "$green_ok" -lt "$edge" ] && [ "$edge" -lt "$stop" ]; } ||
    fail "second release: expected web-green ok < edge reload < stop blue, got $green_ok $edge $stop"
[ -n "$reload_old" ] && [ "$reload_old" -lt "$green_ok" ] || fail "the running blue web was not reloaded onto api-green before green web started"
grep -q 'server api-green:3000' "$WORK/runtime/web-dynamic/api-upstream.conf" || fail "web upstream does not name api-green"
grep -q 'bylinecrm-production-web-green:80' "$DYN/bylinecrm-production.conf" || fail "edge file does not name the green web colour"
grep -q 'server_name crm.pinionnewswire.com' "$DYN/bylinecrm-production.conf" || fail "production edge file does not name crm.pinionnewswire.com"
[ "$(cat "$WORK/runtime/ACTIVE_COLOUR")" = green ] || fail "ACTIVE_COLOUR not green"
rm -rf "$WORK"

# ── The new api never becomes healthy: revert, blue untouched. ──
scenario production 0 '' 1 https blue
[ "$STATUS" -ne 0 ] || fail "release with an unhealthy api exited 0"
grep -q "reverting to the blue colour" <<<"$OUT" || fail "revert not reported"
grep -q 'up -d --no-deps web-green' "$CALLS" && fail "started web-green although api-green never got healthy"
grep -q ' stop ' "$CALLS" && fail "stopped the live colour during a failed release"
grep -q 'rm -sf api-green web-green' "$CALLS" || fail "new colour not removed on revert"
grep -q 'server api-blue:3000' "$WORK/runtime/web-dynamic/api-upstream.conf" || fail "web upstream not put back on api-blue"
[ "$(cat "$WORK/runtime/ACTIVE_COLOUR")" = blue ] || fail "ACTIVE_COLOUR changed on a failed release"
[ -d "$WORK/runtime/deploy.lock" ] && fail "lock left behind after a revert"
rm -rf "$WORK"

# ── The edge refuses the rendered file: install-edge restores it, the release reverts. ──
scenario staging 0 '' 0 https-refuse blue
[ "$STATUS" -ne 0 ] || fail "release exited 0 although the edge refused the file"
grep -q 'restored the previous bylinecrm-staging.conf' <<<"$OUT" || fail "edge file not restored"
grep -q 'bylinecrm-staging-web-blue:80' "$DYN/bylinecrm-staging.conf" || fail "edge file does not still name blue after the restore"
grep -q 'exec newswireos-web-1 nginx -s reload' "$CALLS" && fail "edge reloaded with a failing file"
grep -q ' stop ' "$CALLS" && fail "stopped the live colour although the edge was never switched"
grep -q 'server api-blue:3000' "$WORK/runtime/web-dynamic/api-upstream.conf" || fail "web upstream not put back on api-blue"
rm -rf "$WORK"

if [ "$failures" -eq 0 ]; then
    echo "release-preflight: all checks passed"
else
    echo "release-preflight: $failures check(s) failed" >&2
    exit 1
fi
