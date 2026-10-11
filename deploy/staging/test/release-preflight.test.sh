#!/usr/bin/env bash
# release-preflight.test.sh — release-remote.sh refuses before migrating when the environment would
# not boot the new image (#120), and goes ahead, in order, when it would.
#
# Runs the real release-remote.sh and bootstrap-secrets.sh against a temporary runtime directory, with
# a fake `docker` first on PATH that records every call and answers the environment check as the
# scenario says. What check-env itself decides is covered by apps/api/src/cli/check-env.spec.ts; this
# covers what the release does with the answer. No docker, root or network needed.
#
# Usage: bash deploy/staging/test/release-preflight.test.sh

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
RELEASE="$HERE/../release-remote.sh"
SHA=0000000000000000000000000000000000000120
failures=0

fail() {
    echo "FAIL: $*" >&2
    failures=$((failures + 1))
}

# scenario <check-env exit code> <check-env stdout> → sets $WORK, $STATUS, $OUT, $CALLS
scenario() {
    WORK=$(mktemp -d)
    mkdir -p "$WORK/bin" "$WORK/runtime" "$WORK/releases"
    CALLS="$WORK/calls"
    : >"$CALLS"
    printf '%s' "$2" >"$WORK/check.out"
    cat >"$WORK/bin/docker" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$CALLS"
case "\$*" in
    *"run --rm --no-deps -T api node dist/cli/check-env.js"*)
        echo " Container bylinecrm-staging-api-run-1 Creating" >&2
        cat "$WORK/check.out"
        exit $1 ;;
esac
exit 0
EOF
    chmod +x "$WORK/bin/docker"
    set +e
    OUT=$(PATH="$WORK/bin:$PATH" BYLINECRM_RUNTIME="$WORK/runtime" BYLINECRM_RELEASES="$WORK/releases" \
        BYLINECRM_API_UID="$(id -u)" BYLINECRM_API_GID="$(id -g)" bash "$RELEASE" "$SHA" 2>&1)
    STATUS=$?
    set -e
}

# The release a new required variable would have broken (2026-10-11: MAIL_FROM).
scenario 1 $'MAIL_FROM: required when NODE_ENV=production (transactional mail, #93)\nRESEND_API_KEY: required when NODE_ENV=production (transactional mail, #93)'
[ "$STATUS" -ne 0 ] || fail "refusing release exited 0"
grep -q 'does not boot this release — nothing was changed' <<<"$OUT" || fail "refusal not explained"
grep -q '  MAIL_FROM: required when NODE_ENV=production' <<<"$OUT" || fail "MAIL_FROM not named"
grep -q 'install-resend-key.sh' <<<"$OUT" || fail "no install command for RESEND_API_KEY"
grep -q 'Container bylinecrm-staging-api-run-1' <<<"$OUT" && fail "compose progress shown as a problem"
grep -q 'run --rm migrate' "$CALLS" && fail "migrated despite the refusal"
grep -q ' up ' "$CALLS" && fail "started a service despite the refusal"
[ -f "$WORK/runtime/DEPLOYED_SHA" ] && fail "recorded DEPLOYED_SHA despite the refusal"
[ -d "$WORK/runtime/deploy.lock" ] && fail "left the deploy lock behind"
grep -q '^MAIL_FROM=' "$WORK/runtime/staging.env" || fail "bootstrap-secrets did not write the release's environment"
rm -rf "$WORK"

# The check cannot run at all (no output): say so, show docker's own error, refuse.
scenario 125 ''
[ "$STATUS" -ne 0 ] || fail "release went ahead when the check could not run"
grep -q 'the environment check could not run' <<<"$OUT" || fail "unrunnable check not reported"
grep -q 'run --rm migrate' "$CALLS" && fail "migrated when the check could not run"
rm -rf "$WORK"

# An environment that boots: the check comes after the pull and before the migration, and the release
# completes.
scenario 0 ''
[ "$STATUS" -eq 0 ] || fail "passing release exited $STATUS: $OUT"
order=$(grep -nE 'pull --quiet|check-env\.js|run --rm migrate' "$CALLS" | cut -d: -f1 | tr '\n' ' ')
read -r pull check migrate <<<"$order"
{ [ -n "${migrate:-}" ] && [ "$pull" -lt "$check" ] && [ "$check" -lt "$migrate" ]; } ||
    fail "expected pull < check-env < migrate, got lines: $order"
[ "$(cat "$WORK/runtime/DEPLOYED_SHA" 2>/dev/null)" = "$SHA" ] || fail "DEPLOYED_SHA not recorded"
rm -rf "$WORK"

if [ "$failures" -eq 0 ]; then
    echo "release-preflight: all checks passed"
else
    echo "release-preflight: $failures check(s) failed" >&2
    exit 1
fi
