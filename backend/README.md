# App Builder (Strands Agents starter)

A minimal but real foundation for a Replit-style coding agent:

```
Browser ──POST /runs──▶ FastAPI ──job──▶ Redis list ──▶ worker (Strands agent)
Browser ◀──SSE────────── FastAPI ◀── Redis Stream ◀──── tool + text events
                                                         │
                                                         ▼
                                          per-user Docker sandbox (/workspace volume)
```

## What does what

| File | Job |
|---|---|
| `app/api.py` | HTTP API. Creates runs, streams events (SSE). Never talks to the LLM. |
| `app/worker.py` | Pulls jobs from Redis and runs one agent per job. Holds the API key. |
| `app/agent.py` | The Strands agent: model, system prompt, tools, streaming callback. |
| `app/tools.py` | The tools the agent can call. All of them act inside the sandbox. |
| `app/sandbox.py` | One Docker container + volume per user. Swap this file to change sandbox tech. |
| `app/preview.py` | Reverse proxy that shows the app running in a user's sandbox (subdomain per preview link). |
| `app/events.py` | Publishes events to a Redis Stream (replayable on reconnect). |
| `app/config.py` | Environment-based settings. |
| `sandbox_image/Dockerfile` | The image user sandboxes are created from (Node + Python + git). |

## Run it

Requirements: Python 3.10+, Docker.

```bash
cd backend
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
cp .env.example .env            # add your AI_API_KEY

docker compose up -d            # Redis
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

You should see `status`, `text`, `tool_start`, `tool_result` and finally `done` events. To look at
what the agent built: `docker exec -it sbx-demo-user ls /workspace`.

## Projects and chat history

Every run belongs to a project (`project_id`, default `main`). A project has its own sandbox,
its own files and its own saved conversation, so a second prompt like "now add login" continues
where the first one stopped. Only one run can be active per project at a time (a second request
gets HTTP 409 until the first finishes).

```bash
curl -s -X POST localhost:8000/runs -H 'Content-Type: application/json' -H 'X-User-Id: demo-user' \
  -d '{"prompt":"Add a delete-all button","project_id":"main"}'
```

## Live preview

The agent is told to run the app on `0.0.0.0:3000` (`PREVIEW_PORT`) inside the sandbox. To view it:

1. Set `PREVIEW_DOMAIN` in `.env`. It must be a wildcard domain pointing at this server.
   With no domain of your own, use nip.io. For a server at `3.80.104.25`:
   `PREVIEW_DOMAIN=3.80.104.25.nip.io`
2. Restart the API, then ask for a link:

```bash
curl -s -X POST localhost:8000/preview -H 'Content-Type: application/json' -H 'X-User-Id: demo-user' \
  -d '{"project_id":"main"}'
# -> {"url":"http://ab12cd34ef567890.3.80.104.25.nip.io:8000/", ...}
```

3. Open that URL in your browser (or put it in an iframe in your UI).

Open port 8000 on the server's firewall only to the people who should see previews.
The preview link is a secret URL that expires after 24 hours. WebSockets (for example Vite hot reload)
are not proxied yet.

## Event types the front end receives

| event | data |
|---|---|
| `status` | `{state}` |
| `text` | `{text}` model text, in small batches |
| `tool_start` | `{name, input}` |
| `tool_result` | `{name, output}` (clipped) |
| `done` | `{summary}` |
| `error` | `{message}` |

## Know before you ship

- **Not run-tested here.** The syntax is checked, and the Strands calls (`AnthropicModel`, `@tool`,
  `callback_handler`) follow the current Strands docs, but start with the Try it step above and
  expect to fix small things.
- **Strands is the agent framework, not the sandbox.** It provides the loop, tool decorator, streaming,
  model providers, MCP and multi-agent. The Docker sandbox here is our code in `sandbox.py`.
  The example tools in the separate `strands-agents-tools` package are not used here on purpose,
  because they are meant for trusted environments. Our tools only ever act inside the sandbox.
- **Dev auth only.** `current_user` trusts a client-supplied id. Replace it before going public.
- **Sandbox network is `bridge`** so installs work. In production use an egress proxy that allows
  only package registries, and keep API keys out of the sandbox.
- **Docker is a starter boundary.** For untrusted users move to gVisor, Firecracker or a hosted
  sandbox. Only `sandbox.py` changes.
- Chat history is saved with Strands' `FileSessionManager` on the worker's disk (`SESSIONS_DIR`).
  With more than one worker machine, switch to a shared disk or `S3SessionManager`. As far as I know
  Strands trims old messages by default (sliding window), so very long projects will lose early
  chat context. Add summarization later. The files themselves are never lost.
- Verify `FileSessionManager(session_id=..., storage_dir=...)` against the Strands docs for the
  version you install; session APIs have been changing between releases.

## Suggested next steps (in order)

1. Run it end to end and read the event stream.
2. Browser tools (Playwright in the sandbox): open the app, click through it, screenshot, read console errors.
3. Real auth (the current user id is trusted from the client) and a per-user project limit.
4. Project templates (copy a known-good starter into `/workspace` before the first run).
5. File tree + file content endpoints for the editor panel.
6. Evals: a folder of prompts plus automatic checks (does it build, does a smoke test pass).
7. Idle sandbox cleanup, per-user quotas, rate limits.
