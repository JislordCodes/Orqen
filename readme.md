# Orqen

Describe an app in a chat; an AI agent plans it, writes real code inside a private Docker sandbox,
checks it in a headless browser, and shows it running live. The code stays a normal project, so it
can be exported and still work.

| Part | Folder | Stack |
|---|---|---|
| Frontend: node-canvas editor, chat, executions, tests | `frontend/` | Vite, React, TypeScript, Tailwind, React Flow, Monaco |
| Backend: API, agent worker, sandboxes, live preview | `backend/` | FastAPI, Redis (queue + streams), Strands Agents (OpenAI-compatible LLM), Docker |
| Infrastructure | `infra/terraform/`, `docker-compose.prod.yml`, `deploy/` | AWS (ECS Fargate, EC2, ElastiCache, S3, ALB), Caddy |

**Production:** frontend on Vercel, backend on AWS. Start with
**[docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)**.

## Docs

- [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md): step-by-step runbook (AWS bootstrap, Terraform, secrets, DNS, images, Vercel, smoke tests, scaling, backups, monitoring, rollback, cost, security)
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md): components, diagram, request flow
- [docs/ENV.md](docs/ENV.md): every environment variable
- [docs/PRODUCTION-CHECKLIST.md](docs/PRODUCTION-CHECKLIST.md): what is done, what is left, decisions to make
- [backend/README.md](backend/README.md), [frontend/README.md](frontend/README.md): working on each part

## How it works

```
Browser ──POST /runs──▶ API (FastAPI) ──job──▶ Redis list ──▶ worker (Strands agent)
Browser ◀──SSE───────── API ◀──────── Redis Stream ◀──────── tool + text events
Browser ──https://<token>.preview.<domain>──▶ API preview proxy ──▶ sandbox app (:3000)
                                                                        │
                                                    one Docker sandbox per project (/workspace volume)
```

1. The browser sends a prompt to the API, which queues a job in Redis and returns a `run_id`.
2. A worker picks up the job and runs the agent (planner, then builder). Its tools act only inside
   that project's Docker sandbox.
3. Every step is published to a Redis Stream; the browser reads it live over Server-Sent Events.
4. The built app runs in the sandbox and is opened through a preview link.

Only the worker holds the LLM key. The API never calls the model and does not need Docker.

## Repo layout

```
orqen/
├── readme.md                  you are here
├── start-stack.sh             one-shot dev/demo stack inside a Hark sandbox (host networking + tunnels)
├── cf-tunnel.sh, lr-tunnel.sh tunnels used by start-stack.sh
├── docker-compose.prod.yml    single-host production (Caddy + API + worker + Redis)
├── deploy/caddy/              Caddy image (Route 53 DNS module) + Caddyfile
├── docs/                      deployment, architecture, env reference, checklist
├── infra/
│   ├── bootstrap-state.sh     creates the Terraform state bucket + lock table
│   └── terraform/             AWS: VPC, ALB/ACM, ECS (API), EC2 ASG (worker), ElastiCache, S3, ECR, IAM, alarms
├── .github/workflows/         ci.yml, deploy-backend.yml
├── backend/
│   ├── app/
│   │   ├── api.py             HTTP API: runs, SSE events, projects, preview links, health/ready
│   │   ├── auth.py            AUTH_MODE=dev (X-User-Id) | jwt (JWKS)
│   │   ├── worker.py          job loop, graceful shutdown + re-queue, health server, heartbeats
│   │   ├── agent.py           Strands agents (planner/builder), sessions (file or S3)
│   │   ├── harness.py         prompts, plan/feature files
│   │   ├── tools.py           tools the agent calls (all inside the sandbox)
│   │   ├── sandbox.py         one container + volume per project, networking, snapshots
│   │   ├── snapshots.py       snapshot titles, S3 upload/download/listing
│   │   ├── uicheck.py         headless Chromium route check
│   │   ├── preview.py         preview reverse proxy
│   │   ├── events.py          Redis client + per-run event publishing
│   │   ├── logging_setup.py   text / JSON logging
│   │   └── config.py          environment-based settings
│   ├── tests/                 pytest (no Redis/Docker needed)
│   ├── sandbox_image/         image sandboxes are created from
│   ├── Dockerfile             API image
│   ├── Dockerfile.worker      worker image (Chromium, host Docker socket)
│   ├── docker-compose.yml     local Redis
│   └── requirements*.txt      pinned dependencies
└── frontend/
    ├── src/                   app (lib/api.ts = API client, lib/auth.ts = token provider)
    └── vercel.json            Vercel config (SPA rewrite, cache headers)
```

**One rule:** the frontend and backend only talk through the HTTP API below.

## Local development

Requirements: Python 3.12, Node 22, Docker.

```bash
# backend
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements-dev.txt
cp .env.example .env                  # set NEBIUS_API_KEY, BASE_URL, MODEL_ID
docker compose up -d                  # Redis
docker build -t appbuilder-sandbox:latest sandbox_image
uvicorn app.api:app --port 8000       # terminal 1
python -m app.worker                  # terminal 2
python -m pytest -q tests             # tests

# frontend
cd frontend
cp .env.example .env                  # VITE_API_URL=http://localhost:8000
npm install && npm run dev            # http://localhost:5173
```

Inside a Hark sandbox, `./start-stack.sh` brings everything up (host networking, tunnels).

## API

Auth: `X-User-Id: <id>` in dev (`AUTH_MODE=dev`), `Authorization: Bearer <JWT>` in production
(`AUTH_MODE=jwt`). The SSE route also accepts `?user_id=` / `?access_token=` because EventSource
cannot set headers.

| Method | Path | What it does |
|---|---|---|
| POST | `/runs` | Start a run. Body `{ prompt, project_id?="main", mode?="auto"\|"plan"\|"build" }` → `{ run_id, project_id }`. 409 if the project already has an active run. |
| GET | `/runs/{run_id}/events` | SSE stream of the run's events; reconnect with `Last-Event-ID` to replay. `poll=1` = long-poll mode for buffering tunnels. |
| GET | `/projects` | The user's projects (from runs and snapshots) with recent runs and the active run. |
| POST | `/preview` | Body `{ project_id }` → `{ url, expires_in }` (secret link, 24 h). |
| GET | `/health` | `{ok:true}` when the process and Redis answer. |
| GET | `/live` | Liveness, no dependencies. |
| GET | `/ready` | Readiness: Redis, plus live worker count and queue depth. |

Events: `status {state}`, `phase {phase, session?}`, `text {text}`, `tool_start {name, input}`,
`tool_result {name, output}`, `plan`, `features`, `checks`, `done {summary, state}`, `error {message}`.
A run interrupted by a worker restart emits `status {state:"requeued"}` and continues on the same stream.

## Working on this repo

- Never commit `.env` files; only `.env.example`. If a key is ever committed, revoke it.
- `main` stays deployable; work on a branch and open a pull request. CI must pass.
- If you change an endpoint, event or env var, update this README and `docs/ENV.md` in the same PR.
