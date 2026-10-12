#!/usr/bin/env bash
# rollback.sh <env> — redeploy an environment's previously recorded release (P5-4a). Runs FROM the Mac.
#
# Reads PREVIOUS_SHA in the environment's runtime directory on the server (written by
# release-remote.sh when a different sha is deployed) and runs deploy.sh with it — the same
# pull/check/migrate/blue-green path as any deploy, so it costs no downtime either. Migrations only
# move forward: rolling back the images does not roll back the schema, so a release whose migration is
# not backward-compatible with the previous code needs a forward fix instead (docs/deploy/*.md, "Rollback").
#
# Environment: DEPLOY_HOST (default newswireos-vps), DRY=1.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
bylinecrm_env "${1:?usage: rollback.sh <staging|production>}"
HOST=${DEPLOY_HOST:-newswireos-vps}

previous=$(ssh -o BatchMode=yes "$HOST" "cat $BYLINECRM_RUNTIME/PREVIOUS_SHA 2>/dev/null" || true)
if [ -z "$previous" ]; then
    echo "rollback: no PREVIOUS_SHA recorded for $BYLINECRM_ENV on $HOST — nothing to roll back to" >&2
    exit 1
fi
echo "rollback: redeploying $previous to $BYLINECRM_ENV" >&2
exec "$HERE/deploy.sh" "$BYLINECRM_ENV" "$previous"
