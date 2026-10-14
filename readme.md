# Nodebase

A Replit-style Nodebase. You describe an app in a chat, an AI agent writes real code inside a private sandbox, and you watch it run live. The code stays a normal project, so it can be exported to GitHub and still work.

**Status:** the backend is built and has run end to end. The frontend (node-canvas editor) is in `frontend/`; see `frontend/README.md`.

| Part | Folder | Status |
|---|---|---|
| Backend (API, agent, sandboxes, live preview) | `backend/` | Working starter |
| Frontend (node-canvas editor and chat) | `frontend/` | First version: Vite + React + React Flow, works live or in Demo mode |

## How it works

```
Browser ──POST /runs──▶ FastAPI ──job──▶ Redis list ──▶ worker (Strands agent)
Browser ◀──SSE────────── FastAPI ◀── Redis Stream ◀──── tool + text events
                                                         │
                                                         ▼
                                          per-user Docker sandbox (/workspace volume)
```

1. The browser sends a prompt to the API.
2. The API puts a job on a Redis queue and returns a `run_id`.
3. A worker picks up the job and runs one agent. The agent calls tools that act only inside that user's Docker sandbox.
4. Every step (text, tool calls, results) is published to a Redis Stream.
5. The browser reads that stream live over Server-Sent Events (SSE).
6. The app the agent builds can be opened through a preview link.

The API never talks to the AI model. Only the worker holds the model API key.

## Repo layout

```
NodeBase/
├── README.md                 <- you are here
├── backend/
│   ├── README.md             <- detailed backend notes
│   ├── app/
│   │   ├── api.py            HTTP API: creates runs, streams events (SSE)
│   │   ├── worker.py         pulls jobs from Redis, runs one agent per job
│   │   ├── agent.py          the Strands agent: model, prompt, tools, streaming
│   │   ├── tools.py          tools the agent can call (all act inside the sandbox)
│   │   ├── sandbox.py        one Docker container + volume per user
│   │   ├── preview.py        reverse proxy that shows the running app
│   │   ├── events.py         publishes events to a Redis Stream
│   │   └── config.py         environment-based settings
│   ├── sandbox_image/
│   │   └── Dockerfile        image the user sandboxes are created from
│   ├── docker-compose.yml    Redis
│   ├── requirements.txt
│   └── .env.example
└── frontend/                 <- to be created
```

**One rule:** the frontend and backend only talk through the HTTP API described below. Neither imports code from the other.

## Quick start (backend)

Requirements: Python 3.10+, Docker.

```bash
cd backend
python -m venv .venv && source .venv/bin/activate    # on Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env            # add your ANTHROPIC_API_KEY

docker compose up -d            # starts Redis
docker build -t appbuilder-sandbox:latest sandbox_image

# terminal 1
uvicorn app.api:app --host 0.0.0.0 --port 8000
# terminal 2
python -m app.worker
```

Try it:

```bash
RUN=$(curl -s -X POST localhost:8000/runs \
  -H 'Content-Type: application/json' -H 'X-User-Id: demo-user' \
  -d '{"prompt":"Build a small Flask todo app with a README and run it"}' | python -c 'import sys,json;print(json.load(sys.stdin)["run_id"])')

curl -N -H 'X-User-Id: demo-user' localhost:8000/runs/$RUN/events
```

You should see `status`, `text`, `tool_start`, `tool_result` and finally `done` events. To look at what the agent built: `docker exec -it sbx-demo-user ls /workspace`.

## API the frontend will use

All requests send the header `X-User-Id` (development auth only, see "Before going public").

| Method | Path | What it does |
|---|---|---|
| POST | `/runs` | Start a run. Body: `{ "prompt": string, "project_id"?: string }`. Returns `{ run_id }`. |
| GET | `/runs/{run_id}/events` | Stream events for a run (SSE). Replays from the start if you reconnect. |
| POST | `/preview` | Get a preview link. Body: `{ "project_id": string }`. Returns `{ url }`. |

**Projects and chat history.** Every run belongs to a project (`project_id`, default `main`). A project has its own sandbox, files and saved conversation, so "now add login" continues where the last prompt stopped. Only one run can be active per project at a time. A second request gets HTTP 409 until the first finishes.

**Events the frontend receives:**

| event | data |
|---|---|
| `status` | `{ state }` |
| `text` | `{ text }`, model text in small batches |
| `tool_start` | `{ name, input }` |
| `tool_result` | `{ name, output }` (clipped) |
| `done` | `{ summary }` |
| `error` | `{ message }` |

**Live preview.** The agent runs the built app on `0.0.0.0:3000` inside the sandbox. To make previews open in a browser, set `PREVIEW_DOMAIN` in `backend/.env` to a wildcard domain pointing at your server. With no domain of your own, use nip.io, for example `PREVIEW_DOMAIN=3.80.104.25.nip.io`. Preview links are secret URLs that expire after 24 hours. WebSockets (such as Vite hot reload) are not proxied yet.

## Frontend

Built in `frontend/` (Vite, React, TypeScript, Tailwind, React Flow, Monaco). Run it with `cd frontend && npm install && npm run dev`. The original brief:

- A **node-canvas editor**: every software component (auth, database, and so on) is a node, and you connect nodes together.
- Tabs for **Editor**, **Executions** and **Tests**, with a **chat bar** along the bottom.
- A **light, minimal look**: warm off-white, dot-matrix style type, hairline wires. It should not look like a generic AI-made dashboard.
- The real code always stays in the project, so the canvas is a view over actual files, never a replacement for them.

The first frontend milestone should be small and prove the whole loop:
1. A chat box that sends a prompt to `POST /runs`.
2. A panel that shows the live events from `GET /runs/{run_id}/events`.
3. An iframe that shows the preview link when the run is done.

Decide the frontend stack (framework, styling) before creating the folder, and add its own `frontend/README.md` and `frontend/.env.example` with the backend address.

## Before going public

- **Auth is for development only.** The API trusts the user id the client sends. Replace it with real login before anyone else uses it.
- **Docker is a starter boundary.** For untrusted users, move to gVisor, Firecracker or a hosted sandbox. Only `sandbox.py` changes.
- **Sandbox network is `bridge`** so installs work. In production, use an egress proxy that allows only package registries, and keep API keys out of the sandbox.
- **Chat history** is saved on the worker's disk. With more than one worker machine, use a shared disk or `S3SessionManager`. Old messages are trimmed by default, so very long projects lose early chat context. The files themselves are never lost.
- **Open port 8000** on the server's firewall only to the people who should see previews.
- **Not fully tested.** The backend has run end to end once. Expect to fix small things, and check the session API against the Strands version you install.

## Roadmap

1. Build the first frontend milestone above.
2. Browser tools (Playwright in the sandbox): open the app, click through it, screenshot, read console errors.
3. Real auth and a per-user project limit.
4. Project templates (copy a known-good starter into `/workspace` before the first run).
5. File tree and file content endpoints for the editor panel.
6. GitHub export of a project.
7. Evals: a folder of prompts plus automatic checks (does it build, does a smoke test pass).
8. Idle sandbox cleanup, per-user quotas, rate limits.

## Working on this repo

- Never commit `.env` files. Commit only `.env.example`. If a real key is ever committed, revoke it and make a new one.
- `main` stays working. Make changes on a branch and open a pull request.
- If you change an endpoint or event, update the API tables in this README in the same pull request.

Suggested root `.gitignore`:

```
.venv/
__pycache__/
node_modules/
.env
.env.*
!.env.example
.DS_Store
```