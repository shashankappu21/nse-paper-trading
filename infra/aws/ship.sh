#!/usr/bin/env bash
# Ship the current repository (all commits, including unpushed ones) to the EC2 host via the private
# artifact bucket, without needing GitHub access from either side:
#   git bundle -> s3://$NSE_ARTIFACT_BUCKET/releases/<sha>.bundle -> instance fetches into /opt/nse/app
#
#   infra/aws/ship.sh            # ships HEAD of the current branch
set -euo pipefail
: "${NSE_ARTIFACT_BUCKET:?set NSE_ARTIFACT_BUCKET}"
cd "$(git rev-parse --show-toplevel)"

sha=$(git rev-parse --short HEAD)
branch=$(git rev-parse --abbrev-ref HEAD)
bundle="$(mktemp -d)/nse-$sha.bundle"
git bundle create "$bundle" "$branch" >/dev/null
aws s3 cp --only-show-errors "$bundle" "s3://$NSE_ARTIFACT_BUCKET/releases/$sha.bundle"
echo "[ship] uploaded $(du -h "$bundle" | cut -f1) bundle for $branch@$sha"

"$(dirname "$0")/ssm-run.sh" "set -e
aws s3 cp --only-show-errors s3://$NSE_ARTIFACT_BUCKET/releases/$sha.bundle /tmp/nse.bundle
if [ ! -d /opt/nse/app/.git ]; then
  sudo -u ubuntu git clone -q -b $branch /tmp/nse.bundle /opt/nse/app
else
  cd /opt/nse/app && sudo -u ubuntu git fetch -q /tmp/nse.bundle $branch && sudo -u ubuntu git checkout -q -B $branch FETCH_HEAD
fi
cd /opt/nse/app && git log --oneline -1"
