# Orqen deployment runbook

Frontend on **Vercel**, backend on **AWS** (eu-west-1 by default). Follow the steps in order; each
ends with a check. Architecture: [ARCHITECTURE.md](ARCHITECTURE.md). Every variable:
[ENV.md](ENV.md). Open decisions and risks: [PRODUCTION-CHECKLIST.md](PRODUCTION-CHECKLIST.md).

```
Vercel (SPA) ──HTTPS──▶ ALB (api.<domain>, *.preview.<domain>) ──▶ API on ECS Fargate ──▶ ElastiCache Redis
                                                                      │  preview proxy          ▲
                                                                      ▼                         │
                                                 Worker EC2 ASG (Docker) ── sandboxes ── S3 snapshots/sessions
```

---

## 0. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| AWS account + admin access for the bootstrap | – | Afterwards CI deploys through an OIDC role. |
| AWS CLI v2 | ≥ 2.15 | `aws sts get-caller-identity` works. |
| Terraform | ≥ 1.6 (tested 1.9.8, AWS provider 6.70) | |
| Docker with buildx | ≥ 24 | Images are `linux/amd64` (worker hosts are x86_64 m6i). On Apple Silicon use `--platform linux/amd64`. |
| Node 22 + npm | | Only to build the frontend locally. |
| jq, curl | | Smoke tests. |
| A domain in a **Route 53 public hosted zone** | | You pass its zone id. If DNS lives elsewhere, delegate a subdomain (e.g. `orqen.example.com`) to Route 53. |
| An identity provider that issues JWTs (Auth0, Clerk, Cognito, Supabase…) | | Needed for `AUTH_MODE=jwt`. See checklist: the frontend still needs its login wired in. |
| Nebius AI Studio API key | | Or any OpenAI-compatible endpoint (`llm_base_url`, `llm_model_id`). |

Names below assume `project = orqen`, `environment = prod`, so resources are `orqen-prod-*`.

---

## 1. AWS account bootstrap (once)

```bash
export AWS_PROFILE=orqen-admin AWS_REGION=eu-west-1
./infra/bootstrap-state.sh eu-west-1 > infra/terraform/backend.hcl   # state bucket + lock table
cat infra/terraform/backend.hcl
```

The script creates `orqen-tfstate-<account>` (versioned, encrypted, public access blocked) and the
DynamoDB table `orqen-tf-locks`. `backend.hcl` is git-ignored.

Recommended account hygiene (not automated): enable CloudTrail and GuardDuty, set an AWS Budgets
alert (see cost estimate), enable MFA on the root user and stop using it.

---

## 2. Configure Terraform

```bash
cd infra/terraform
cp terraform.tfvars.example terraform.tfvars      # git-ignored
$EDITOR terraform.tfvars
terraform init -backend-config=backend.hcl
```

Minimum to set: `domain_name`, `hosted_zone_id`, `cors_origins` (your Vercel production URL and
custom domain), and for `auth_mode = "jwt"`: `jwt_jwks_url`, `jwt_issuer`, `jwt_audience`.
Optional: `alarm_email`, `worker_instance_type`, `redis_num_nodes = 2` (Multi-AZ failover).
If the account already has the GitHub OIDC provider, set `create_github_oidc_provider = false`.

---

## 3. Apply order

The ECS service and the worker hosts pull images at start, and the worker needs the LLM key, so
create the registries and the secret first, push images, then apply everything.

```bash
# 3a. Registries + secrets containers
terraform apply \
  -target='aws_ecr_repository.repo' \
  -target=aws_secretsmanager_secret.nebius_api_key \
  -target=aws_secretsmanager_secret.redis_auth -target=aws_secretsmanager_secret_version.redis_auth

# 3b. The LLM key (never put it in Terraform; it would land in state)
aws secretsmanager put-secret-value \
  --secret-id orqen-prod/nebius-api-key --secret-string 'YOUR_NEBIUS_KEY'
```

### 3c. Build and push the first images (from a workstation)

```bash
cd "$(git rev-parse --show-toplevel)"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
REG=$ACCOUNT.dkr.ecr.eu-west-1.amazonaws.com
TAG=$(git rev-parse --short=12 HEAD)
aws ecr get-login-password | docker login --username AWS --password-stdin $REG

docker buildx build --platform linux/amd64 -f backend/Dockerfile        -t $REG/orqen/api:$TAG     -t $REG/orqen/api:latest     --push backend
docker buildx build --platform linux/amd64 -f backend/Dockerfile.worker -t $REG/orqen/worker:$TAG  -t $REG/orqen/worker:latest  --push backend
docker buildx build --platform linux/amd64                              -t $REG/orqen/sandbox:$TAG -t $REG/orqen/sandbox:latest --push backend/sandbox_image
```

### 3d. Everything else

```bash
cd infra/terraform
terraform plan -out tfplan     # review: ~70 resources
terraform apply tfplan         # 15-25 min (ElastiCache and ACM validation are the slow parts)
terraform output
```

The first apply uses the `latest` tags (`api_image_tag`, `worker_image_tag`, `sandbox_image_tag`).
After that, CI pins git-sha tags (task definition revisions and the SSM parameters
`/orqen/prod/worker_image`, `/orqen/prod/sandbox_image`); Terraform ignores those fields so it never
rolls them back.

**Check:** `terraform output api_url` prints `https://api.<domain>`;
`aws ecs describe-services --cluster orqen-prod --services orqen-prod-api --query 'services[0].runningCount'` is 2;
the worker instance appears under EC2 with tag `Role=orqen-worker`.

---

## 4. Secrets

| Secret | Where | Set by |
|---|---|---|
| `NEBIUS_API_KEY` | Secrets Manager `orqen-prod/nebius-api-key` | You (step 3b). Rotate: put a new value, then run the worker deploy (step 7) so hosts re-render their env. |
| `REDIS_PASSWORD` | Secrets Manager `orqen-prod/redis-auth-token` | Terraform (random 48 chars). Injected into API tasks by ECS and into workers by `render-env.sh`. |
| GitHub → AWS | none: OIDC role `orqen-prod-github-deploy` | Terraform. |
| JWT signing keys | at your identity provider | The API only fetches the public JWKS. |

Nothing secret is in the frontend: every `VITE_*` value is public.

Note: the Redis AUTH token is generated by Terraform, so it is also in the (encrypted, private)
state file. If that is unacceptable, generate it outside Terraform and import it.

---

## 5. DNS and certificates

Terraform does all of it in the hosted zone you passed:

- ACM certificate for `api.<domain>` + `*.preview.<domain>` (DNS-validated, auto-renewed).
- `A` alias `api.<domain>` → ALB, `A` alias `*.preview.<domain>` → ALB.

**Check:**
```bash
dig +short api.<domain>
dig +short abc123.preview.<domain>          # same ALB addresses
curl -sI https://api.<domain>/health | head -1
```

---

## 6. GitHub Actions setup

Repository → Settings → Secrets and variables → Actions → **Variables**:

| Variable | Value |
|---|---|
| `AWS_REGION` | `eu-west-1` |
| `AWS_DEPLOY_ROLE_ARN` | `terraform output -raw github_deploy_role_arn` |
| `ORQEN_ENV` | `prod` |

Create an Environment named `production` (Settings → Environments), optionally with required
reviewers. The role trusts `repo:<github_repo>:ref:refs/heads/main` and
`repo:<github_repo>:environment:production` only.

- `ci.yml` runs on every PR / push: frontend typecheck + build, backend compile + pytest,
  terraform fmt + validate, and builds the three images without pushing.
- `deploy-backend.yml` runs on pushes to `main` touching `backend/**`, or manually
  (Actions → Deploy backend → Run workflow) with a worker strategy:
  `ssm-restart` (default: new images, same hosts, sandboxes and volumes kept),
  `instance-refresh` (replace hosts: for AMI/user-data changes; projects restore from S3),
  or `none`.

---

## 7. First deploy and every deploy

First deploy is step 3. Afterwards:

```bash
git push origin main            # or run "Deploy backend" manually
```

What the workflow does: test → build + push `api`, `worker`, `sandbox` tagged with the git sha
(and `latest`) → register a new API task definition revision and wait for the ECS service to be
stable (circuit breaker rolls back automatically) → update the SSM image pointers → run
`/opt/orqen/deploy.sh` on each worker host via SSM Run Command, one host at a time. `deploy.sh`
re-renders `/opt/orqen/worker.env` from Secrets Manager/SSM, pulls the images and restarts the
worker; the old worker drains (finishes runs for up to 120 s, then re-queues them).

Manual worker deploy (same thing):

```bash
aws ssm send-command --document-name AWS-RunShellScript \
  --targets Key=tag:Role,Values=orqen-worker --parameters 'commands=["/opt/orqen/deploy.sh"]'
```

Shell on a worker host (no SSH, no key pairs):

```bash
aws ssm start-session --target <instance-id>
sudo journalctl -u orqen-worker -f
sudo docker ps --filter label=appbuilder=sandbox
```

---

## 8. Frontend on Vercel

1. Vercel → Add New Project → import the GitHub repo.
2. **Root Directory: `frontend`**. Framework preset: Vite (also pinned in `frontend/vercel.json`:
   `npm ci`, `npm run build`, output `dist`, SPA rewrite to `index.html`, immutable cache for
   `/assets/*`, no-cache for `index.html`, security headers).
3. Environment variables (Production, and Preview if you use preview deployments):

   | Name | Value |
   |---|---|
   | `VITE_API_URL` | `https://api.<domain>` (no trailing slash) |
   | `VITE_AUTH_TOKEN_STORAGE_KEY` | optional, default `orqen_token` |

   Do **not** set `VITE_SSE_POLL`: in production the browser streams SSE straight from the API.
   `VITE_USER_ID` is only for `AUTH_MODE=dev` backends.
4. Deploy, then add your custom domain (e.g. `app.<domain>`) in Vercel → Domains.
5. Put every frontend origin in `cors_origins` (exact, with `https://`), and if you want Vercel
   preview deployments to reach the API, set `cors_origin_regex`, e.g.
   `^https://orqen-[a-z0-9-]+-yourteam\.vercel\.app$`. `terraform apply` (the API task definition
   changes; ECS rolls it).

`VITE_*` values are baked in at build time: changing `VITE_API_URL` needs a redeploy in Vercel.

**JWT auth in the browser:** the client sends `Authorization: Bearer <token>` (and
`?access_token=` on the EventSource stream) whenever `frontend/src/lib/auth.ts` returns a token. Wire
your provider's SDK once at startup, e.g. `setTokenProvider(() => auth0.getTokenSilently())`. Until a
login UI exists, a token can be tested by `localStorage.setItem('orqen_token', '<jwt>')` in the console.

---

## 9. Smoke tests

```bash
API=https://api.<domain>
curl -s $API/health      # {"ok":true}                 (process + Redis)
curl -s $API/live        # {"ok":true}                 (process only; container health check)
curl -s $API/ready       # {"ok":true,"redis":"ok","workers":1,"queue_depth":0}
```

`workers` counts worker heartbeats; 0 means no worker host is running the worker.

Get a token from your IdP (Auth0 example, machine-to-machine app authorised for the API audience):

```bash
TOKEN=$(curl -s https://YOUR_TENANT.eu.auth0.com/oauth/token -H 'content-type: application/json' \
  -d '{"client_id":"…","client_secret":"…","audience":"https://api.<domain>","grant_type":"client_credentials"}' | jq -r .access_token)
```

A test run, then its live event stream **through the ALB** (events must arrive as they happen,
not all at the end; idle gaps are filled by `: keepalive` comments every 15 s):

```bash
RUN=$(curl -s -X POST $API/runs -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"prompt":"Build a tiny counter app","project_id":"smoke","mode":"plan"}' | jq -r .run_id)
curl -N -H "Authorization: Bearer $TOKEN" "$API/runs/$RUN/events"
# event: status / phase / text / tool_start / tool_result ... / done
```

Reconnect test: interrupt the curl, rerun it with `-H "Last-Event-ID: <last id seen>"`: it resumes.

CORS from the browser origin:

```bash
curl -si -X OPTIONS $API/runs -H 'Origin: https://app.<domain>' -H 'Access-Control-Request-Method: POST' | grep -i access-control-allow-origin
```

Preview (after a build run that started the app):

```bash
curl -s -X POST $API/preview -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' -d '{"project_id":"smoke"}'
# {"url":"https://<16-hex>.preview.<domain>/","expires_in":86400} -> open it
```

Unauthenticated calls must fail: `curl -s -o /dev/null -w '%{http_code}' -X POST $API/runs` → `401`.

The ALB idle timeout is set to **3600 s** in Terraform (`aws_lb.main.idle_timeout`). Check:
`aws elbv2 describe-load-balancer-attributes --load-balancer-arn <arn> | grep -A1 idle_timeout`.

---

## 10. Scaling

| Layer | How | Notes |
|---|---|---|
| API | ECS target tracking on CPU 60 %, `api_desired_count`..`api_max_count` | Stateless; SSE connections are cheap (one Redis XREAD each). |
| Workers (vertical) | `worker_instance_type` + `worker_max_concurrent_runs` | Rule of thumb: concurrent runs ≈ (RAM GiB − 4) / `SANDBOX_MEM`, and ≤ vCPUs. m6i.xlarge → 3, m6i.2xlarge → 6–8. |
| Workers (horizontal) | `aws autoscaling set-desired-capacity --auto-scaling-group-name orqen-prod-worker --desired-capacity N` | Any worker takes any job. A project whose last run was on another host gets a fresh container restored from its S3 snapshot (dependencies reinstall, ~1–3 min). Host affinity and queue-depth autoscaling are follow-ups (checklist). |
| Redis | `redis_node_type`, `redis_num_nodes = 2` for Multi-AZ | Holds streams (capped at ~5000 events/run) and small keys. |

Idle sandboxes: a daily cron on each host removes sandbox containers stopped for 7+ days (volumes
are kept). Running-but-idle sandboxes still hold memory; an idle reaper is a follow-up.

---

## 11. Backups and restore

**What is durable where**

| Data | Store | Protection |
|---|---|---|
| Project source | `s3://orqen-prod-state-<acct>/snapshots/<user>-<project>.tar.gz` | Versioning (old versions kept `snapshot_noncurrent_days` = 30), SSE, TLS-only policy. |
| Pre-replan copies | `…/snapshots/archive/` | → STANDARD_IA after 30 days. |
| Agent chat history | `…/sessions/` | Versioning (7 days). |
| Queue, run streams, locks, preview tokens | ElastiCache | Daily snapshot, 3 kept. Losing it loses in-flight runs and run history lists, not code. |
| Sandbox volumes (incl. `node_modules`) | worker EBS | Disposable: rebuilt from snapshots. |

**Restore a project to an earlier version**

```bash
B=orqen-prod-state-<acct>; K=snapshots/<user>-<project>.tar.gz
aws s3api list-object-versions --bucket $B --prefix $K --query 'Versions[].[VersionId,LastModified,Size]' --output table
aws s3api copy-object --bucket $B --key $K --copy-source "$B/$K?versionId=<VERSION_ID>"
# Make the worker restore it: remove the live container + volume and the local copy on the host
aws ssm start-session --target <instance-id>
sudo docker rm -f sbx-<user>-<project>; sudo docker volume rm ws-<user>-<project>
sudo rm -f /var/lib/orqen/snapshots/<user>-<project>.tar.gz
```

The next run for that project restores the workspace from S3 (restore happens only into an empty
volume, so a surviving volume is never overwritten).

**Restore Redis:** create a new replication group from an ElastiCache snapshot, point `REDIS_URL`
at it (Terraform), redeploy API and workers.

---

## 12. Monitoring

- Logs (JSON): CloudWatch `/orqen/prod/api` and `/orqen/prod/worker`. Logs Insights examples:
  ```
  fields ts, level, msg, path, status, ms | filter status >= 500 | sort ts desc | limit 50
  fields ts, msg, run_id, user, project | filter msg = "starting run" | stats count() by bin(1h)
  fields ts, level, msg, exc | filter level = "ERROR" | sort ts desc
  ```
- Alarms → SNS `orqen-prod-alarms` (confirm the email subscription): ALB target 5xx, unhealthy API
  targets, API CPU, no worker host in service, worker CPU, Redis memory and engine CPU, worker
  ERROR log lines.
- ECS Container Insights is on for the cluster.
- Health: ALB → `/ready`; ECS container → `/live`; worker host → `curl localhost:8081/ready`
  (Redis + Docker) via SSM.
- Worst-case signals to watch by hand at first: `/ready` `queue_depth` growing (add worker
  capacity), LLM provider errors in worker logs, disk usage on worker hosts (`df -h /`).

---

## 13. Rollback

| What | How |
|---|---|
| API | Automatic on failed deploys (circuit breaker). Manual: `aws ecs update-service --cluster orqen-prod --service orqen-prod-api --task-definition orqen-prod-api:<previous revision>`. |
| Worker + sandbox image | `aws ssm put-parameter --overwrite --name /orqen/prod/worker_image --value <reg>/orqen/worker:<old sha>` (same for `sandbox_image`), then run `/opt/orqen/deploy.sh` via SSM (step 7). |
| Infrastructure | Revert the Terraform commit, `terraform plan`, `terraform apply`. State is versioned in S3 if a state file must be recovered. |
| Frontend | Vercel → Deployments → previous deployment → Promote / Instant Rollback. |
| A bad snapshot | Section 11. |

Old images stay in ECR (last 30 kept).

---

## 14. Cost estimate (eu-west-1, on-demand, rough, per month)

| Item | Sizing | ≈ USD |
|---|---|---|
| Worker EC2 | 1 × m6i.xlarge | 156 |
| Worker EBS | 200 GB gp3, 250 MB/s | 23 |
| API Fargate | 2 × (0.5 vCPU, 1 GB) | 36 |
| ALB | 1 ALB + light LCU | 25 |
| NAT gateway | 1 × + ~100 GB processed | 40 |
| ElastiCache | 1 × cache.t4g.small (2 nodes Multi-AZ: ×2) | 25 |
| Public IPv4 | ALB (2) + NAT EIP | 11 |
| CloudWatch | ~10 GB logs, alarms, Container Insights | 15 |
| S3, ECR, Secrets Manager, Route 53 | small | 8 |
| **Total baseline** | | **≈ 340** |

- Each extra worker host: ≈ +180. Multi-AZ Redis: +25. NAT per AZ: +35.
- A 1-year Compute Savings Plan cuts EC2/Fargate ≈ 30 % (baseline ≈ 270).
- **Excluded:** LLM usage (likely the largest cost at scale: set provider-side spend limits),
  data transfer out, Vercel plan.
- Cheaper single-host alternative (`docker-compose.prod.yml` on one m6i.xlarge + EBS + EIP,
  no ALB/NAT/ElastiCache/Fargate): ≈ 185, with no redundancy.

---

## 15. Security notes

- **Auth:** run `AUTH_MODE=jwt` on anything public. `dev` mode trusts a client-sent user id.
  Terraform defaults to `jwt`. Set `JWT_ISSUER` and `JWT_AUDIENCE` so tokens for other apps are rejected.
- **SSE token in the URL:** EventSource cannot send headers, so the stream takes `?access_token=`.
  Use short-lived access tokens; ALB access logs (off by default) would record query strings.
- **Sandboxes run untrusted, AI-written code.** Isolation in place: per-project container,
  resource limits, `no-new-privileges`, own Docker network with VPC and metadata-service traffic
  dropped, IMDSv2 hop limit 1, worker SG only reachable from the API on the ephemeral port range.
  Not in place: kernel isolation (gVisor/Sysbox), egress allow-listing. See checklist.
- **Docker socket:** the worker container mounts `/var/run/docker.sock` (root-equivalent on the
  host). A worker compromise is a host compromise; keep worker hosts single-purpose.
- **Preview links** are bearer URLs (unguessable 64-bit tokens, 24 h). Anyone with the link can view
  that app. Previews are served from a separate domain, so they cannot read the frontend's
  cookies/storage.
- **No SSH:** hosts are reached with SSM Session Manager; no key pairs, no port 22.
- **Encryption:** TLS 1.2/1.3 at the ALB, TLS to Redis, Redis AUTH, S3 SSE + TLS-only policy,
  encrypted EBS. Secrets come from Secrets Manager.
- **Least privilege:** the API task role can only list/read `snapshots/`; workers can read/write
  `snapshots/` and `sessions/`, read two secrets and two SSM parameters; the CI role can push to the
  three repos, update one ECS service, write two SSM parameters, and run commands only on instances
  tagged `Role=orqen-worker`.
- **Rate limiting / abuse:** not implemented in the app yet (checklist). Consider AWS WAF on the ALB
  with a rate-based rule as a first layer.

---

## Appendix A: single-host deployment (docker compose)

For a demo or a small private beta on one machine (any Linux host with Docker, e.g. one EC2
m6i.xlarge with an Elastic IP):

```bash
git clone … && cd orqen
cp backend/.env.example backend/.env.prod && $EDITOR backend/.env.prod   # NEBIUS_API_KEY, BASE_URL, MODEL_ID, CORS_ORIGINS, AUTH_MODE=jwt, JWT_*
export API_DOMAIN=api.example.com PREVIEW_DOMAIN=preview.example.com ACME_EMAIL=ops@example.com
export REDIS_PASSWORD=$(openssl rand -hex 24) DOCKER_GID=$(stat -c %g /var/run/docker.sock)
docker compose -f docker-compose.prod.yml --profile build build sandbox-image
docker compose -f docker-compose.prod.yml up -d --build
```

DNS: `A api.example.com` and `A *.preview.example.com` → the host. Open only 80/443. Caddy gets one
wildcard certificate for `*.preview…` through the Route 53 DNS challenge (instance role or AWS keys
with `route53:ChangeResourceRecordSets` on the zone); for another DNS provider swap the module in
`deploy/caddy/Dockerfile`, or use the on-demand TLS block in `deploy/caddy/Caddyfile` for low volume.
Persist `REDIS_PASSWORD` somewhere safe (it must stay the same across restarts).

## Appendix B: local development (unchanged)

`./start-stack.sh` still brings up the Hark-sandbox demo stack (host networking, tunnels).
`backend/README.md` and `frontend/README.md` cover running each part locally.
