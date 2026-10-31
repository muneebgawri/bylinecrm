#!/usr/bin/env bash
# edge-lock.test.sh — install-edge.sh and the NewswireOS deploy lock (PNW-1193):
#   • R-PNW-1193a: while a NewswireOS deploy holds the lock, it waits; when the lock clears it takes
#     it, installs and reloads the edge, and leaves no lock behind;
#   • R-PNW-1193b: a lock still held when the wait runs out is refused, naming its holder, and is
#     left exactly as it was (never removed, never rewritten);
#   • R-PNW-1193c: while it changes the edge it holds the lock itself, so a NewswireOS deploy that
#     starts then (mkdir) is refused instead of reloading the edge underneath it.
#
# Runs the real install-edge.sh against a temporary directory with a fake `docker`. No docker, root
# or network needed. Usage: bash deploy/env/test/edge-lock.test.sh

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
EDGE="$HERE/../install-edge.sh"
failures=0
fail() {
    echo "FAIL: $*" >&2
    failures=$((failures + 1))
}

WORK=$(mktemp -d)
trap 'rm -rf "$WORK"' EXIT
mkdir -p "$WORK/bin" "$WORK/runtime" "$WORK/dyn"
LOCK="$WORK/deploy.lock"
CALLS="$WORK/calls"
SEEN="$WORK/seen-during-reload"
# The fake edge records every call, and at the reload whether the lock was held and by whom.
cat >"$WORK/bin/docker" <<EOF
#!/usr/bin/env bash
echo "\$*" >>"$CALLS"
case "\$*" in
    *"nginx -s reload"*) cat "$LOCK/holder" >"$SEEN" 2>/dev/null || echo none >"$SEEN" ;;
esac
exit 0
EOF
chmod +x "$WORK/bin/docker"

run_edge() {
    : >"$CALLS"
    rm -f "$SEEN"
    set +e
    OUT=$(PATH="$WORK/bin:$PATH" BYLINECRM_RUNTIME="$WORK/runtime" DYNAMIC_DIR="$WORK/dyn" \
        NEWSWIREOS_LOCK="$LOCK" EDGE_CONF_DIR="$HERE/.." EDGE_LOCK_POLL_SECONDS=1 env "$@" \
        bash "$EDGE" staging http 2>&1)
    STATUS=$?
    set -e
}

# ── R-PNW-1193a: waits for a NewswireOS deploy, then installs ──
mkdir "$LOCK" && echo "apple@mac pid=1 ref=origin/main what=api started=2026-10-31T09:17:09Z" >"$LOCK/holder"
(sleep 2 && rm -rf "$LOCK") &
run_edge EDGE_LOCK_WAIT_SECONDS=30
wait
[ "$STATUS" -eq 0 ] || fail "1193a: exited $STATUS after the lock cleared: $OUT"
grep -q 'nginx -s reload' "$CALLS" || fail "1193a: the edge was not reloaded"
grep -q 'apple@mac' <<<"$OUT" || fail "1193a: the wait does not name the holder: $OUT"
[ -e "$LOCK" ] && fail "1193a: left the lock behind"

# ── R-PNW-1193c: holds the lock itself while it changes the edge ──
grep -q 'bylinecrm-staging install-edge' "$SEEN" 2>/dev/null || fail "1193c: the lock was not ours at the reload: $(cat "$SEEN" 2>/dev/null)"

# ── R-PNW-1193b: a lock held past the wait is refused and left alone ──
mkdir "$LOCK" && echo "apple@mac pid=2 ref=origin/main what=api started=2026-10-31T09:30:00Z" >"$LOCK/holder"
run_edge EDGE_LOCK_WAIT_SECONDS=2
[ "$STATUS" -ne 0 ] || fail "1193b: installed while the lock was held"
grep -q 'nginx -s reload' "$CALLS" && fail "1193b: reloaded the edge while the lock was held"
grep -q 'pid=2' <<<"$OUT" || fail "1193b: the refusal does not name the holder: $OUT"
[ "$(cat "$LOCK/holder" 2>/dev/null)" = "apple@mac pid=2 ref=origin/main what=api started=2026-10-31T09:30:00Z" ] ||
    fail "1193b: the NewswireOS lock was changed or removed"
rm -rf "$LOCK"

if [ "$failures" -gt 0 ]; then
    echo "edge-lock: $failures failure(s)" >&2
    exit 1
fi
echo "edge-lock: ok"
