#!/usr/bin/env bash
# run.sh — every deploy/env test (CI's test job: `pnpm test:deploy`). Each one runs the real scripts
# against a temporary directory with fake docker/rclone; none needs docker, root or network.
set -euo pipefail
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
status=0
for t in release-preflight backup backup-env edge-lock; do
    bash "$HERE/$t.test.sh" || status=1
done
exit $status
