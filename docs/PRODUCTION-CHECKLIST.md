# Production checklist

Status of the `production` branch. ✅ done in code/infra · 📝 specified in docs, needs a person to do
it · ❓ needs a decision.

## Done

| Area | Item |
|---|---|
| Repo | ✅ Root `.gitignore` (deps, builds, `dump.rdb`, sessions, snapshots, `.env*`, tunnel URL files, Terraform state); runtime junk untracked; secret scan of the tree and history found no keys. |
| Repo | ✅ `backend/.env.example`, `frontend/.env.example` list every variable; full reference in `docs/ENV.md`. |
| Frontend | ✅ `frontend/vercel.json`: SPA rewrite, immutable `/assets/*` cache, no-cache `index.html`, security headers. |
| Frontend | ✅ Direct SSE against the API in production; long-poll fallback only on `*.trycloudflare.com` or `VITE_SSE_POLL=1`. |
| Frontend | ✅ Optional bearer token (`src/lib/auth.ts`): header on fetch, `?access_token=` on EventSource. |
| Backend | ✅ CORS allow-list (`CORS_ORIGINS`, `CORS_ORIGIN_REGEX`). |
| Backend | ✅ Pluggable auth: `AUTH_MODE=dev` (unchanged) or `jwt` (JWKS, `iss`/`aud`/`exp` checked, user id from `sub`, hashed when unsafe for container names). |
| Backend | ✅ JSON logs (`LOG_FORMAT=json`), request access log; `/health` (unchanged contract), `/live`, `/ready` (Redis, worker count, queue depth); worker `/health` + `/ready` (Redis + Docker) and Redis heartbeats. |
| Backend | ✅ Graceful worker shutdown: SIGTERM → stop taking jobs → grace period → `Agent.cancel()` → snapshot → re-queue at the front with the same `run_id` (lock kept, max 3 attempts). |
| Backend | ✅ Snapshots to S3 (`SNAPSHOT_S3_BUCKET`): upload after each local tar, restore from S3 when there is no local file; API lists projects from S3. Chat sessions to S3 (`SESSIONS_S3_BUCKET`). |
| Backend | ✅ Per-sandbox networking: `SANDBOX_NETWORK=bridge`/named network, preview port published on a random host port, address recorded in Redis, API proxies to any worker host; many previews at once. `host` mode kept for `start-stack.sh`. |
| Backend | ✅ Fixed: the worker ignored `REDIS_URL` (hard-coded `localhost:6379`); now honours `REDIS_URL` + `REDIS_PASSWORD` + TLS. |
| Backend | ✅ Pinned dependencies (versions from `backend/.venv`), `requirements-dev.txt`, 21 pytest tests (auth, CORS, runs, caddy-ask, previews, snapshots, sandbox networking, re-queue). |
| Containers | ✅ `backend/Dockerfile` (API, non-root, uvicorn workers, proxy headers), `backend/Dockerfile.worker` (non-root, Chromium, tini, host Docker socket), `docker-compose.prod.yml` (Caddy + API + worker + Redis), Caddy wildcard TLS via Route 53 DNS-01. |
| AWS | ✅ Terraform: VPC (2 AZ), ALB (idle 3600 s) + ACM (api + `*.preview`), API on ECS Fargate with autoscaling + circuit breaker, worker EC2 ASG (AL2023, Docker, sandbox firewall, IMDSv2 hop 1, drain lifecycle hook, SSM deploy), ElastiCache Redis (TLS + AUTH), S3 state bucket (versioned, encrypted, lifecycle, TLS-only), ECR ×3, Secrets Manager, CloudWatch logs + alarms + SNS, Route 53 records, least-privilege IAM, GitHub OIDC deploy role, remote state example + bootstrap script. `terraform validate` passes. |
| CI/CD | ✅ `ci.yml` (frontend, backend, terraform, image builds) and `deploy-backend.yml` (ECR push via OIDC, ECS rollout, worker SSM restart or instance refresh). |

## Needs doing before real users (📝)

- 📝 **Frontend login.** `AUTH_MODE=jwt` is ready on the API, but the UI has no sign-in yet. Add the
  chosen provider's SDK and call `setTokenProvider(...)` (see `frontend/src/lib/auth.ts`). Hide or
  remove the "User id (dev auth)" field in the connection dialog for production builds.
- 📝 Run the runbook end to end on a real account (nothing has been applied to AWS yet; `terraform
  plan`/`apply` and the Docker image builds were not run in this environment).
- 📝 Confirm `docker build` of all three images in CI (the `images` job does it on the first PR).
- 📝 Set AWS Budgets alerts and LLM provider spend limits.
- 📝 Enable CloudTrail + GuardDuty on the account; consider ALB access logs (mind tokens in query strings).
- 📝 Preview proxy does not forward WebSockets (fine for `vite preview` builds, breaks apps that need
  WebSockets). Options: proxy upgrades in `preview.py`, or route previews ALB → a Caddy/Traefik on
  each worker host that resolves `token → container` (needs host affinity, see below).
- 📝 Host affinity for multi-host workers: today any worker takes any job, so a project can bounce
  between hosts and reinstall dependencies from scratch. Fix: per-host queues keyed by the host that
  owns `sandbox:<id>:addr`, falling back to the shared queue.
- 📝 Worker autoscaling on queue depth (publish `LLEN jobs` and busy slots as a CloudWatch metric;
  scale the ASG on it). Today the ASG size is manual.
- 📝 Idle sandbox reaper (stop sandboxes with no run for N hours; volumes stay, snapshots in S3).
- 📝 Per-user project quota and periodic cleanup of old volumes/snapshots.
- 📝 Load test SSE fan-out and the preview proxy (one shared `httpx` client per API process).

## Decisions for Ayo (❓)

1. ❓ **Auth provider**: Auth0, Clerk, Cognito, Supabase or Firebase? All work with `AUTH_MODE=jwt`
   (JWKS). Clerk/Auth0 are fastest to wire into a React SPA; Cognito keeps everything in AWS.
2. ❓ **LLM spending limits**: per-user daily run/tool-call caps and a monthly provider cap. Today a
   user can start unlimited runs (one at a time per project, unlimited projects).
3. ❓ **Abuse limits / rate limiting**: suggested starting point: WAF rate rule on the ALB
   (e.g. 300 req/5 min/IP), plus in-app limits (e.g. 20 runs/user/day, 5 projects/user, max 1–2
   concurrent runs per user) enforced in `POST /runs` with Redis counters.
4. ❓ **Sandbox isolation level**: Docker + firewall is a starter boundary for untrusted code.
   Options in increasing strength/cost:
   - **gVisor (`runsc`)**: install on worker hosts, set `SANDBOX_RUNTIME=runsc`. Strong syscall
     isolation, some compatibility/perf cost for npm builds. Recommended next step.
   - **Sysbox (`sysbox-runc`)**: rootless-in-container, good for Docker-in-sandbox use cases.
   - **Firecracker microVMs / a hosted sandbox (E2B, Modal, Daytona)**: strongest; only
     `sandbox.py` changes.
5. ❓ **Docker socket exposure**: the worker holds `/var/run/docker.sock` (host root). Options: accept
   it with single-purpose hosts (current), put a Docker socket proxy in front allowing only the API
   calls `sandbox.py` makes, or move to rootless Docker on the worker hosts.
6. ❓ **Sandbox egress policy**: internet is open (npm/pip need it). Tighter: an egress proxy
   allowing only package registries (npm, PyPI, GitHub), via `HTTP(S)_PROXY` in the sandbox image.
7. ❓ **Preview access**: bearer links (anyone with the URL, 24 h) vs. requiring the owner's login on
   previews (would need a cookie on the preview domain).
8. ❓ **Data retention / privacy**: how long to keep snapshots, archives, chat sessions and run
   history; whether users can delete projects (needs an endpoint). Relevant for GDPR if EU users.
9. ❓ **Availability target**: single NAT + single-node Redis + 1 worker host is cheapest
   (≈ $340/mo). For higher availability: `single_nat_gateway=false`, `redis_num_nodes=2`, ≥2 worker
   hosts (≈ +$240/mo).
10. ❓ **Region**: default `eu-west-1` (Ireland). Lagos users may see lower latency from
    `af-south-1` (Cape Town) at higher prices; check Nebius latency from either.
