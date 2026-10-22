# Deployment guide — single AWS EC2 instance + Vercel

```
                    HTTPS (Let's Encrypt)
 Browser ──► Vercel (React SPA) ──────────┐
    │                                      ▼
    └──── wss://api.example.com/ws ──► EC2: Caddy :443 ──► api :4000 ──► Postgres
                                                  │                 └──► Redis ◄── worker
```

The backend (Caddy, API, worker, Postgres, Redis) runs with Docker Compose on one EC2 instance.
The frontend is a static build on Vercel that talks to the API over HTTPS/WSS.

> **Why a single instance?** It is the cheapest setup that still shows real production concerns
> (TLS, health checks, migrations on deploy, non-root containers, persistent volumes). The services are
> stateless apart from Postgres/Redis, so the upgrade path is clear: move Postgres to RDS, Redis to
> ElastiCache, and run N API + M worker containers on ECS behind an ALB. Nothing in the code assumes a
> single process (rate limits, schedules, WebSocket fan-out and idempotency all live in Redis/Postgres).

---

> **Prefer one click?** [`infra/aws/cloudformation.yml`](../infra/aws/cloudformation.yml) creates everything in
> sections 1–2 (instance, Elastic IP, 80/443-only security group, SSM role, Docker) and lets you manage the host
> through AWS Systems Manager instead of SSH. See [AWS_SETUP.md](AWS_SETUP.md).

## 1. Launch the instance

| Setting | Value |
|---|---|
| AMI | Ubuntu Server 24.04 LTS (x86_64 or arm64 — all images are multi-arch) |
| Type | `t3.small` (2 GB RAM) is enough for demo traffic; `t3.medium` for load tests |
| Storage | 20 GB gp3 |
| Security group | Inbound **22** (your IP only), **80** and **443** (0.0.0.0/0). Nothing else — Postgres/Redis/API ports are never exposed. |
| Elastic IP | Allocate and associate one so the DNS record survives restarts |

Point a DNS **A record** (e.g. `api.example.com`) at the Elastic IP. Caddy needs it to resolve before it
can obtain a certificate.

## 2. Install Docker

```bash
ssh ubuntu@<elastic-ip>
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker ubuntu && newgrp docker
docker compose version   # Compose v2 ships with Docker Engine
```

Optional but recommended on a 2 GB box — add swap so `docker build` does not OOM:

```bash
sudo fallocate -l 2G /swapfile && sudo chmod 600 /swapfile && sudo mkswap /swapfile && sudo swapon /swapfile
echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
```

## 3. Configure

```bash
git clone https://github.com/<you>/nse-paper-trading.git && cd nse-paper-trading
cp .env.example .env
```

Edit `.env` — the values that matter in production:

```dotenv
JWT_SECRET=<output of: openssl rand -hex 32>
POSTGRES_PASSWORD=<output of: openssl rand -hex 16>
MARKET_DATA_PROVIDER=yahoo
API_DOMAIN=api.example.com
CORS_ORIGINS=https://nse-paper-trading.vercel.app
LOG_LEVEL=info
```

`.env` is git-ignored and never baked into images; Compose passes the values as environment variables.
For a team setup, store them in AWS SSM Parameter Store / Secrets Manager and render `.env` at deploy time.

## 4. Start

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.yml -f docker-compose.prod.yml ps
```

Startup order is enforced by health checks:

1. `postgres` and `redis` become healthy (`pg_isready`, `redis-cli ping`)
2. `migrate` runs once: applies SQL migrations (advisory-locked, so concurrent runs are safe) and the
   idempotent seed (NIFTY 50, ~2 years of daily candles from Yahoo, demo account) and exits 0
3. `api` and `worker` start only after `migrate` **completed successfully**
4. `caddy` starts once `api` reports healthy, obtains a certificate and serves `https://api.example.com`

Verify:

```bash
curl https://api.example.com/ready            # {"status":"ready","db":"up","redis":"up"}
open https://api.example.com/docs             # Swagger UI
```

Demo account: **demo@nsepaper.dev / Demo@12345** (created by the seed).

## 5. Deploy the frontend on Vercel

1. Import the GitHub repository in Vercel.
2. **Root Directory:** `apps/web` (Vercel detects Vite).
3. **Install Command:** `cd ../.. && npm ci` (the web app imports `packages/shared` from the monorepo).
4. **Build Command:** `npm run build` · **Output Directory:** `dist`
5. **Environment variable:** `VITE_API_URL=https://api.example.com`
6. Deploy, then put the Vercel URL in the API's `CORS_ORIGINS` and restart the API:
   `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d api`

`apps/web/vercel.json` rewrites every path to `index.html` so client-side routes (`/stocks/TCS`) work on refresh.
The WebSocket URL is derived from `VITE_API_URL` (`https` → `wss`).

## 6. Operating it

| Task | Command |
|---|---|
| Logs (JSON, one line per event) | `docker compose logs -f api worker` |
| Follow one order end-to-end | `docker compose logs api worker \| grep <request-id>` |
| Redeploy after `git pull` | `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d --build` (migrations run first) |
| Trigger the EOD job manually | `docker compose exec worker node -e "require('@nse/core').createScheduledQueue(process.env.REDIS_URL).add('eod-close',{}).then(()=>process.exit(0))"` |
| Postgres shell | `docker compose exec postgres psql -U trader trading` |
| Backup | `docker compose exec -T postgres pg_dump -U trader trading \| gzip > backup-$(date +%F).sql.gz` |

Cron a nightly `pg_dump` to S3 (`aws s3 cp`) for real backups. Redis runs with AOF so queued jobs and
schedules survive a restart; it is otherwise a cache and can be rebuilt.

### Cost (ap-south-1, on-demand, approx.)

| Item | Monthly |
|---|---|
| t3.small | ~US$15 |
| 20 GB gp3 | ~US$2 |
| Elastic IP (attached) | ~US$3.6 |
| Vercel Hobby | free |

## 7. Hardening checklist

- [x] Containers run as non-root (`node` uid 1000, `nginx-unprivileged`)
- [x] Only 80/443 exposed; DB and Redis reachable only on the Compose network
- [x] HTTPS with automatic renewal; HSTS header
- [x] Secrets via environment, never committed or baked into images
- [x] Health checks gate startup ordering; `restart: unless-stopped`
- [x] Rate limits on login/register (per IP) and order placement (per user)
- [ ] Ship logs to CloudWatch (`awslogs` log driver) and alarm on 5xx rate
- [ ] Automated `pg_dump` to S3
- [ ] Move to RDS + ElastiCache when more than one app host is needed
