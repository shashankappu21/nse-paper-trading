# Giving the automation an EC2 host (SSM, no SSH)

The cloud sandbox Claude runs in **cannot open SSH (port 22)** to arbitrary hosts, but it **can reach the
AWS APIs over HTTPS**. So instead of SSH, the instance is managed with **AWS Systems Manager Run Command**:
Claude calls `ssm:SendCommand`, the SSM agent on the instance runs the shell command and returns the output.
No key pair, no open port 22, and the IAM policy limits the credentials to **this one instance**.

```
Claude sandbox ──HTTPS──► AWS SSM API ◄──(agent polls over HTTPS)── EC2 instance
      │                                                                ▲
      └──HTTPS──► S3 artifact bucket (git bundles, long logs) ─────────┘
```

Everything is created by one CloudFormation template: [`infra/aws/cloudformation.yml`](../infra/aws/cloudformation.yml).

---

## Step 0 — get the code onto GitHub (needed for any new session)

A new Claude session starts from a fresh clone of the GitHub repository, so unpushed commits would be lost.
Do **one** of:

- **A. Fix GitHub access** (best): install the Claude GitHub App on `shashankappu21/project` at
  https://github.com/apps/claude/installations/select_target (or reconnect GitHub in claude.ai settings), then
  ask Claude to push.
- **B. Push the bundle yourself** from your laptop:
  ```bash
  git clone nse-paper-trading.bundle nse-paper-trading && cd nse-paper-trading
  git remote set-url origin https://github.com/shashankappu21/project.git
  git push -u origin main
  ```
  Then (optional) rename the repo to `nse-paper-trading` and make it public in GitHub → Settings.

## Step 1 — create the stack (~5 minutes)

Region: **ap-south-1 (Mumbai)** is closest to NSE users. The account needs a default VPC (new accounts have one).

**Console:** CloudFormation → *Create stack* → *With new resources* → *Upload a template file* →
`infra/aws/cloudformation.yml` → stack name `nse-paper-trading` → keep defaults (t3.medium, 30 GB) →
tick *"I acknowledge that AWS CloudFormation might create IAM resources"* → *Submit*.

**CLI (equivalent):**
```bash
aws cloudformation deploy --region ap-south-1 --stack-name nse-paper-trading \
  --template-file infra/aws/cloudformation.yml --capabilities CAPABILITY_IAM
aws cloudformation describe-stacks --region ap-south-1 --stack-name nse-paper-trading \
  --query 'Stacks[0].Outputs' --output table
```

It creates: an Ubuntu 24.04 instance (IMDSv2 only, encrypted gp3 disk, Docker + AWS CLI + 2 GB swap installed by
user-data), an Elastic IP, a security group with **only 80/443 open**, an instance role with
`AmazonSSMManagedInstanceCore`, a private encrypted S3 bucket (objects expire after 14 days), and an
**operator policy**.

Note these outputs: `InstanceId`, `ArtifactBucket`, `OperatorPolicyArn`, `FreeHttpsDomain`
(e.g. `13-234-5-6.sslip.io` — a wildcard-DNS name for the Elastic IP that Caddy can get a real
Let's Encrypt certificate for, so you don't need to buy a domain).

## Step 2 — create a least-privilege key for the automation

IAM → *Users* → *Create user* `claude-operator` (no console access) → *Attach policies directly* → choose the
policy from `OperatorPolicyArn` (named like `nse-paper-trading-OperatorPolicy-…`) → create →
*Security credentials* → *Create access key* → use case *Command Line Interface*.

That key can only: run commands on this one instance, read command results, and read/write the artifact
bucket. It cannot create resources, read other buckets, or touch anything else in the account.

## Step 3 — give the key to the Claude environment (never paste it in chat)

In Claude Code on the web: the cloud environment menu in the session's title bar → **Edit** → environment
variables:

| Variable | Value |
|---|---|
| `AWS_ACCESS_KEY_ID` | from Step 2 |
| `AWS_SECRET_ACCESS_KEY` | from Step 2 |
| `AWS_DEFAULT_REGION` | `ap-south-1` |
| `EC2_INSTANCE_ID` | stack output `InstanceId` |
| `NSE_ARTIFACT_BUCKET` | stack output `ArtifactBucket` |
| `NSE_PUBLIC_HOST` | stack output `FreeHttpsDomain` (or your own domain pointing at the Elastic IP) |

Network access: the AWS endpoints were reachable with the current setting. If you switch the environment to a
*Limited* level, add `amazonaws.com` (covers `ssm.*`, `s3.*`, `ec2.*`) to the allowed domains.

Environment variables are picked up by **new** sessions — start a new session on this repository and say
*"continue on EC2"*.

## Step 4 — what the automation does with it

```bash
infra/aws/ssm-run.sh 'test -f /opt/nse/bootstrap.done && docker --version'   # host is ready
infra/aws/ship.sh                                                            # code via git bundle + S3
infra/aws/ssm-run.sh 'cd /opt/nse/app && ...'                                # anything else
```

Planned work on the host (the things the sandbox cannot do):

1. Seed with **real Yahoo Finance data** (the sandbox blocks Yahoo) and verify live quotes and candles.
2. Deploy with `docker-compose.prod.yml` + Caddy on `NSE_PUBLIC_HOST` → a real **HTTPS/WSS** URL.
3. Run the CI pipeline steps on a clean machine.
4. Run **k6 from a dedicated machine** against the real deployment (cleaner numbers than the shared sandbox).
5. Run the Playwright end-to-end smoke test against the HTTPS deployment.
6. Frontend on Vercel needs either the Vercel UI (2 minutes, see [DEPLOYMENT.md](DEPLOYMENT.md#5-deploy-the-frontend-on-vercel))
   or a `VERCEL_TOKEN` environment variable.

## Cost and cleanup

| Item (ap-south-1, on-demand) | Approx. |
|---|---|
| t3.medium | US$0.045/h ≈ US$33/month |
| 30 GB gp3 | ≈ US$2.6/month |
| Elastic IP (attached) | ≈ US$3.6/month |
| SSM Run Command, S3 (tiny) | ≈ free |

Stop the instance when not in use (the Elastic IP keeps the address). To remove everything:

```bash
aws s3 rm s3://<ArtifactBucket> --recursive          # a bucket must be empty before deletion
aws cloudformation delete-stack --region ap-south-1 --stack-name nse-paper-trading
```

…and delete the `claude-operator` IAM user (and its access key) in IAM.
