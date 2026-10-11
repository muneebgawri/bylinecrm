#!/usr/bin/env bash
# deploy.sh <commit> — deploy BylineCRM staging (P5-4a). Runs FROM the Mac.
#
# Ships the images CI built for <commit> (ghcr.io/muneebgawri/bylinecrm-{api,web}:<sha>); nothing is
# built on the server, which also serves NewswireOS production.
#
# Two ssh connections, no nested quoting:
#   1. upload `git archive <sha> deploy/staging` to /opt/bylinecrm/releases/<sha>/
#   2. run that release's release-remote.sh <sha> (lock, pull, migrate, api, web, record)
# then a read-only probe of https://staging.crm.pinionnewswire.com/health through the NewswireOS
# edge — the only contact with anything NewswireOS serves (skip with SKIP_EDGE_PROBE=1 before the
# edge is installed).
#
# Environment: DEPLOY_HOST (default newswireos-vps), DRY=1 (print the plan only),
# SKIP_EDGE_PROBE=1.

set -euo pipefail

REF=${1:?usage: deploy.sh <commit-ish>   (must be on origin, with CI images built)}
HOST=${DEPLOY_HOST:-newswireos-vps}
PUBLIC_URL=${BYLINECRM_PUBLIC_URL:-https://staging.crm.pinionnewswire.com}
REPO_ROOT=$(git rev-parse --show-toplevel)
cd "$REPO_ROOT"

git fetch -q origin
SHA=$(git rev-parse --verify "${REF}^{commit}")
if ! git branch -r --contains "$SHA" | grep -q 'origin/'; then
    echo "deploy: $SHA is on no origin branch — CI has not built images for it; refusing" >&2
    exit 1
fi
RELEASE_DIR="/opt/bylinecrm/releases/$SHA"

cat >&2 <<EOF
deploy: plan
  host      $HOST
  commit    $SHA  ($(git log -1 --format=%s "$SHA"))
  images    ghcr.io/muneebgawri/bylinecrm-api:$SHA, bylinecrm-web:$SHA
  upload    deploy/staging → $RELEASE_DIR
  run       $RELEASE_DIR/deploy/staging/release-remote.sh $SHA
  probe     ${PUBLIC_URL}/health $([ "${SKIP_EDGE_PROBE:-0}" = 1 ] && echo '(skipped)')
EOF
if [ "${DRY:-0}" = 1 ]; then
    echo "deploy: DRY=1 — nothing done" >&2
    exit 0
fi

echo "deploy: uploading deploy files for $SHA" >&2
git archive --format=tar "$SHA" deploy/staging |
    ssh -o BatchMode=yes "$HOST" "mkdir -p $RELEASE_DIR && tar -x -C $RELEASE_DIR"

echo "deploy: releasing" >&2
ssh -o BatchMode=yes "$HOST" "bash $RELEASE_DIR/deploy/staging/release-remote.sh $SHA"

if [ "${SKIP_EDGE_PROBE:-0}" = 1 ]; then
    echo "deploy: $SHA deployed; edge probe skipped" >&2
    exit 0
fi
body=$(curl -fsS --max-time 15 "${PUBLIC_URL}/health") || {
    echo "deploy: the stack is up but ${PUBLIC_URL}/health did not answer through the edge" >&2
    exit 1
}
case "$body" in
    *'"status":"ok"'*) echo "deploy: $SHA deployed and healthy through the edge" >&2 ;;
    *)
        echo "deploy: edge answered but not ok: $body" >&2
        exit 1
        ;;
esac
