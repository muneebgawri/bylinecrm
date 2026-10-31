#!/usr/bin/env bash
# deploy.sh <env> <commit> — deploy BylineCRM to an environment (P5-4a, P5-4c). Runs FROM the Mac.
#
# Ships the images CI built for <commit> (ghcr.io/muneebgawri/bylinecrm-{api,web}:<sha>); nothing is
# built on the server, which also serves NewswireOS production.
#
# Two ssh connections, no nested quoting:
#   1. upload `git archive <sha> deploy/env` to /opt/bylinecrm/releases/<sha>/  (shared by every
#      environment: the files are the same, lib.sh tells them apart)
#   2. run that release's release-remote.sh <env> <sha> (lock, pull, check, migrate, blue/green
#      cutover, record)
# then a read-only probe of <public url>/health through the NewswireOS edge — the only contact with
# anything NewswireOS serves (skip with SKIP_EDGE_PROBE=1 before the edge is installed).
#
# Environment: DEPLOY_HOST (default newswireos-vps), DRY=1 (print the plan only),
# SKIP_EDGE_PROBE=1.

set -euo pipefail

HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=lib.sh
. "$HERE/lib.sh"
ENV_NAME=${1:?usage: deploy.sh <staging|production> <commit-ish>   (must be on origin, with CI images built)}
REF=${2:?usage: deploy.sh <staging|production> <commit-ish>   (must be on origin, with CI images built)}
bylinecrm_env "$ENV_NAME"
HOST=${DEPLOY_HOST:-newswireos-vps}
PUBLIC_URL=$BYLINECRM_PUBLIC_URL
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

git fetch -q origin
SHA=$(git rev-parse --verify "${REF}^{commit}")
if ! git branch -r --contains "$SHA" | grep -q 'origin/'; then
    echo "deploy: $SHA is on no origin branch — CI has not built images for it; refusing" >&2
    exit 1
fi
RELEASE_DIR="$BYLINECRM_RELEASES/$SHA"

cat >&2 <<EOF
deploy: plan
  environment  $BYLINECRM_ENV  ($PUBLIC_URL, project $BYLINECRM_PROJECT, runtime $BYLINECRM_RUNTIME)
  host         $HOST
  commit       $SHA  ($(git log -1 --format=%s "$SHA"))
  images       ghcr.io/muneebgawri/bylinecrm-api:$SHA, bylinecrm-web:$SHA
  upload       deploy/env → $RELEASE_DIR
  run          $RELEASE_DIR/deploy/env/release-remote.sh $BYLINECRM_ENV $SHA
  probe        ${PUBLIC_URL}/health $([ "${SKIP_EDGE_PROBE:-0}" = 1 ] && echo '(skipped)')
EOF
if [ "${DRY:-0}" = 1 ]; then
    echo "deploy: DRY=1 — nothing done" >&2
    exit 0
fi

echo "deploy: uploading deploy files for $SHA" >&2
git archive --format=tar "$SHA" deploy/env |
    ssh -o BatchMode=yes "$HOST" "mkdir -p $RELEASE_DIR && tar -x -C $RELEASE_DIR"

echo "deploy: releasing $BYLINECRM_ENV" >&2
# A release can sit quietly for up to 45 minutes waiting for a NewswireOS deploy's lock (PNW-1193):
# keepalives stop an idle connection being dropped, which would hang the release up mid-flight.
ssh -o BatchMode=yes -o ServerAliveInterval=30 -o ServerAliveCountMax=6 "$HOST" \
    "bash $RELEASE_DIR/deploy/env/release-remote.sh $BYLINECRM_ENV $SHA"

if [ "${SKIP_EDGE_PROBE:-0}" = 1 ]; then
    echo "deploy: $SHA deployed to $BYLINECRM_ENV; edge probe skipped" >&2
    exit 0
fi
body=$(curl -fsS --max-time 15 "${PUBLIC_URL}/health") || {
    echo "deploy: the stack is up but ${PUBLIC_URL}/health did not answer through the edge" >&2
    exit 1
}
case "$body" in
    *'"status":"ok"'*) echo "deploy: $SHA deployed to $BYLINECRM_ENV and healthy through the edge" >&2 ;;
    *)
        echo "deploy: edge answered but not ok: $body" >&2
        exit 1
        ;;
esac
