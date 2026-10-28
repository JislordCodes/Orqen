# Environment variable reference

All backend settings are read in `backend/app/config.py` (and `backend/app/auth.py`); `backend/.env`
is loaded in dev. Frontend settings are Vite build-time variables. **SECRET** marks values that must
come from a secret store (Secrets Manager in AWS), never from git or plain task env.

Columns: **API** / **W** (worker) = which process reads it. Defaults keep the existing dev flow.

## Backend: general and logging

| Variable | Default | API | W | Description |
|---|---|---|---|---|
| `APP_ENV` | `dev` | ✓ | ✓ | `production` only switches the default `LOG_FORMAT` to `json`. |
| `LOG_LEVEL` | `INFO` | ✓ | ✓ | Python log level. |
| `LOG_FORMAT` | `text` (`json` in production) | ✓ | ✓ | `json` = one JSON object per line (CloudWatch Logs Insights friendly). |

## Redis

| Variable | Default | API | W | Description |
|---|---|---|---|---|
| `REDIS_URL` | `redis://localhost:6379` | ✓ | ✓ | `rediss://<endpoint>:6379` for TLS (ElastiCache). |
| `REDIS_PASSWORD` | empty | ✓ | ✓ | **SECRET.** AUTH token. Kept out of the URL so it can be injected from a secret. |

## LLM (worker only)

| Variable | Default | Description |
|---|---|---|
| `NEBIUS_API_KEY` | – (required) | **SECRET.** Key for the OpenAI-compatible endpoint. The worker exits without it. |
| `BASE_URL` | empty | OpenAI-compatible base URL, e.g. `https://api.studio.nebius.com/v1/`. |
| `MODEL_ID` | empty | Model for builder (and planner unless overridden), e.g. `zai-org/GLM-5.3`. |
| `PLANNER_MODEL_ID` | empty | Optional stronger planner model. |
| `MAX_TOKENS` | `32000` | Max output tokens per model call. |
| `CONTEXT_WINDOW` | `131072` | Context size of `MODEL_ID`; drives proactive summarisation. |

## API: CORS and auth

| Variable | Default | Description |
|---|---|---|
| `CORS_ORIGINS` | `http://localhost:3000,http://localhost:5173,http://localhost:4173` | Comma-separated exact origins. Production: your Vercel/production domain(s). |
| `CORS_ORIGIN_REGEX` | empty | Optional regex for extra origins, e.g. Vercel preview URLs `^https://orqen-[a-z0-9-]+-team\.vercel\.app$`. |
| `AUTH_MODE` | `dev` | `dev`: trust `X-User-Id` / `?user_id=` (**never on a public endpoint**). `jwt`: require `Authorization: Bearer <JWT>` (or `?access_token=` on the SSE route). |
| `JWT_JWKS_URL` (alias `JWKS_URL`) | empty | JWKS endpoint of the identity provider. Required for `jwt`. |
| `JWT_ISSUER` | empty | Expected `iss`. Empty = not checked (set it). |
| `JWT_AUDIENCE` | empty | Expected `aud`. Empty = not checked (set it). |
| `JWT_ALGORITHMS` | `RS256` | Comma-separated allowed algorithms. |
| `JWT_USER_CLAIM` | `sub` | Claim used as the user id. Ids that are not `[a-z0-9_-]{1,40}` are mapped to `u` + 24 hex chars of their SHA-256 (they name containers, volumes and keys). |

## Sandboxes (worker)

| Variable | Default | Description |
|---|---|---|
| `SANDBOX_IMAGE` | `appbuilder-sandbox:latest` | Image sandboxes are created from (ECR URI in AWS). |
| `SANDBOX_NETWORK` | `bridge` | `host`: share the host network (start-stack.sh; one preview at a time). `bridge` or a user-defined network name (AWS: `orqen-sbx`, auto-created if missing): own netns per sandbox, `PREVIEW_PORT` published on a random host port. Existing containers on a different network are recreated (the volume is kept). |
| `SANDBOX_ADVERTISE_HOST` | `127.0.0.1` | Address the API and the UI check use to reach this host's published ports. AWS: the instance's private IP (user-data). Compose: `172.17.0.1`. |
| `SANDBOX_PUBLISH_IP` | `0.0.0.0` | Interface published ports bind to. |
| `SANDBOX_RUNTIME` | empty | OCI runtime, e.g. `runsc` (gVisor) or `sysbox-runc`. Must be installed on the host. |
| `SANDBOX_MEM` | `3g` | Memory limit per sandbox. |
| `SANDBOX_CPUS` | `1.0` | CPU limit per sandbox. |

## Worker limits and lifecycle

| Variable | Default | Description |
|---|---|---|
| `MAX_CONCURRENT_RUNS` | `4` | Runs per worker process. Size to host RAM / `SANDBOX_MEM`. |
| `MAX_TOOL_CALLS` | `80` | Tool-call budget per agent session (start-stack.sh uses 200). |
| `MAX_SESSIONS` | `6` | Builder sessions per run. |
| `WORKER_SHUTDOWN_GRACE` | `120` | Seconds a SIGTERM'd worker waits for runs to finish before cancelling and re-queueing them. Container stop timeout must be ≥ this + 45. |
| `MAX_JOB_ATTEMPTS` | `3` | Times one run may be re-queued by shutdowns. |
| `WORKER_HEARTBEAT_TTL` | `30` | TTL of `worker:<id>:heartbeat` (seen by API `/ready`). |
| `WORKER_HEALTH_PORT` | `0` (image: `8081`) | Port for the worker's `GET /health` and `GET /ready` (Redis + Docker). `0` = off. |
| `UI_CHECK` | `1` | `0` disables the headless Chromium check. |
| `CHROMIUM_BIN` | auto (`chromium`) | Browser path (image: `/usr/bin/chromium`). |

## Preview links (API)

| Variable | Default | Description |
|---|---|---|
| `PREVIEW_PORT` | `3000` | Port the generated app listens on inside the sandbox (also used by the worker). |
| `PREVIEW_DOMAIN` | empty | Wildcard domain routed to the API, e.g. `preview.example.com`. Empty = no preview links (unless `PREVIEW_URL`). |
| `PREVIEW_SCHEME` | `http` | `https` behind ALB/Caddy with a wildcard cert: links are `https://<token>.<domain>/` with no port. |
| `PREVIEW_TTL` | `86400` | Lifetime of a preview token (seconds). |
| `PREVIEW_URL` / `PREVIEW_URL_FILE` | empty | Single-box demo: a tunnel URL pointed at `PREVIEW_PORT` (used only without `PREVIEW_DOMAIN`). |

## Durable state

| Variable | Default | API | W | Description |
|---|---|---|---|---|
| `SESSIONS_DIR` | `./sessions` | | ✓ | Local chat history (single worker host). |
| `SESSIONS_S3_BUCKET` | empty | | ✓ | Store chat history in S3 (Strands `S3SessionManager`); needed with several worker hosts. |
| `SESSIONS_S3_PREFIX` | `sessions/` | | ✓ | Key prefix. |
| `SNAPSHOT_DIR` | empty (worker image: `/data/snapshots`) | ✓ | ✓ | Local snapshot dir. Empty disables snapshots (the worker always needs it to snapshot; S3 upload happens after the local tar). |
| `SNAPSHOT_EVERY` | `15` | | ✓ | Tool calls between snapshots. |
| `SNAPSHOT_S3_BUCKET` | empty | ✓ | ✓ | Also upload snapshots to S3; restore from S3 when no local file exists; the API lists projects from it. |
| `SNAPSHOT_S3_PREFIX` | `snapshots/` | ✓ | ✓ | Key prefix (archives go under `<prefix>archive/`). |
| `AWS_REGION` | SDK default | ✓ | ✓ | Region for S3. Credentials come from the default chain (task role / instance profile). |

## API container

| Variable | Default | Description |
|---|---|---|
| `UVICORN_WORKERS` | `2` | Uvicorn processes per container. |
| `PORT` | `8000` | Listen port. |

## Frontend (Vite, build time, all PUBLIC)

| Variable | Default | Description |
|---|---|---|
| `VITE_API_URL` | empty → Demo mode | API base URL without trailing slash. Production: `https://api.<domain>`. |
| `VITE_USER_ID` | `demo-user` | Dev-auth id sent as `X-User-Id`. Ignored by a `jwt` backend. |
| `VITE_AUTH_TOKEN_STORAGE_KEY` | `orqen_token` | localStorage key read for a bearer token when no token provider is registered (`setTokenProvider()` or `window.orqenAuth.getToken`, see `frontend/src/lib/auth.ts`). |
| `VITE_SSE_POLL` | unset | `1` forces the SSE long-poll fallback (buffering tunnels only). Automatic on `*.trycloudflare.com`. Leave unset in production. |
| `VITE_BASE` | `/` | Base path (GitHub Pages demo: `/orqen/`). Leave unset on Vercel. |

## docker-compose.prod.yml (shell env)

`API_DOMAIN`, `PREVIEW_DOMAIN`, `ACME_EMAIL`, `REDIS_PASSWORD` (**SECRET**), `DOCKER_GID`
(group of `/var/run/docker.sock`), optional `DOCKER_HOST_IP` (default `172.17.0.1`), `SANDBOX_IMAGE`,
`API_IMAGE`, `WORKER_IMAGE`, `UVICORN_WORKERS`. Everything else from `backend/.env.prod`.

## Terraform inputs

See `infra/terraform/variables.tf` and `terraform.tfvars.example`. Required: `domain_name`,
`hosted_zone_id`, `cors_origins`; for `auth_mode = "jwt"` (default) also `jwt_jwks_url`,
`jwt_issuer`, `jwt_audience`.
