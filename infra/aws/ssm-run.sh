#!/usr/bin/env bash
# Run a shell command on the EC2 host through AWS Systems Manager (no SSH, no port 22) and print
# its stdout/stderr; exits with the remote command's exit code.
#
#   infra/aws/ssm-run.sh 'cd /opt/nse/app && docker compose ps'
#   TIMEOUT=1800 infra/aws/ssm-run.sh 'cd /opt/nse/app && docker compose up -d --build'
#
# Env: EC2_INSTANCE_ID, AWS_DEFAULT_REGION (or AWS_REGION), AWS credentials.
# Optional NSE_ARTIFACT_BUCKET: full output is also written there (the API returns only the first 24 KB).
set -euo pipefail

: "${EC2_INSTANCE_ID:?set EC2_INSTANCE_ID}"
CMD="${1:?usage: ssm-run.sh '<shell command>'}"
TIMEOUT="${TIMEOUT:-900}"

params=$(jq -n --arg c "set -o pipefail; $CMD" --arg t "$TIMEOUT" '{commands: [$c], executionTimeout: [$t]}')
s3args=()
[[ -n "${NSE_ARTIFACT_BUCKET:-}" ]] && s3args=(--output-s3-bucket-name "$NSE_ARTIFACT_BUCKET" --output-s3-key-prefix ssm-output)

id=$(aws ssm send-command \
  --instance-ids "$EC2_INSTANCE_ID" \
  --document-name AWS-RunShellScript \
  --comment "nse: ${CMD:0:90}" \
  --parameters "$params" \
  "${s3args[@]}" \
  --query Command.CommandId --output text)

status=Pending
while [[ "$status" =~ ^(Pending|InProgress|Delayed)$ ]]; do
  sleep 3
  status=$(aws ssm get-command-invocation --command-id "$id" --instance-id "$EC2_INSTANCE_ID" \
    --query Status --output text 2>/dev/null || echo Pending)
done

inv=$(aws ssm get-command-invocation --command-id "$id" --instance-id "$EC2_INSTANCE_ID" --output json)
jq -r '.StandardOutputContent' <<<"$inv"
err=$(jq -r '.StandardErrorContent' <<<"$inv")
[[ -n "$err" ]] && printf '%s\n' "$err" >&2
code=$(jq -r '.ResponseCode' <<<"$inv")
echo "[ssm] command $id: $status (exit $code)" >&2
exit "$((code < 0 ? 1 : code))"
