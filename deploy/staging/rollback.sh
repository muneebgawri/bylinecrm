#!/usr/bin/env bash
# rollback.sh — redeploy the previously recorded BylineCRM staging release (P5-4a). Runs FROM the Mac.
#
# Reads /opt/bylinecrm-runtime/PREVIOUS_SHA on the server (written by release-remote.sh when a
# different sha is deployed) and runs deploy.sh with it — the same pull/migrate/health path as any
# deploy. Migrations only move forward: rolling back the images does not roll back the schema, so a
# release whose migration is not backward-compatible with the previous code needs a forward fix
# instead (docs/deploy/staging.md, "Rollback").
#
# Environment: DEPLOY_HOST (default newswireos-vps), DRY=1.

set -euo pipefail

HOST=${DEPLOY_HOST:-newswireos-vps}
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

previous=$(ssh -o BatchMode=yes "$HOST" 'cat /opt/bylinecrm-runtime/PREVIOUS_SHA 2>/dev/null' || true)
if [ -z "$previous" ]; then
    echo "rollback: no PREVIOUS_SHA recorded on $HOST — nothing to roll back to" >&2
    exit 1
fi
echo "rollback: redeploying $previous" >&2
exec "$HERE/deploy.sh" "$previous"
