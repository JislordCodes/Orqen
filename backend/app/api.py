"""FastAPI server. It never runs the agent: it enqueues jobs, relays events, and proxies previews.

Run with:  uvicorn app.api:app --host 0.0.0.0 --port 8000
"""
import json
import os

import httpx
import re
import secrets
import uuid
from typing import Literal

import redis.asyncio as aioredis
from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from . import config, preview

app = FastAPI(title="App Builder API")


from redis.exceptions import TimeoutError as RedisTimeout

r = aioredis.from_url(
    config.REDIS_URL,
    decode_responses=True,
    socket_timeout=30,          # must be longer than the XREAD block below
    socket_connect_timeout=5,
    health_check_interval=30,
)


SLUG = re.compile(r"^[a-z0-9][a-z0-9-]{0,29}$")


@app.middleware("http")
async def preview_router(request: Request, call_next):
    """If the request came in on <token>.<PREVIEW_DOMAIN>, it is a preview request:
    forward it to the user's sandbox instead of handling it as an API call."""
    host = request.headers.get("host", "").split(":")[0].lower()
    suffix = "." + config.PREVIEW_DOMAIN
    if config.PREVIEW_DOMAIN and host.endswith(suffix):
        token = host[: -len(suffix)]
        return await preview.proxy(request, token, r)
    return await call_next(request)


# Added after the preview middleware so CORS headers wrap API responses.
app.add_middleware(
    CORSMiddleware,
    allow_origins=["http://localhost:3000", "http://localhost:5173"],  # your front end in dev
    allow_methods=["*"],
    allow_headers=["*"],
)


async def current_user(
    x_user_id: str = Header(default=""),
    user_id: str = Query(default=""),
) -> str:
    """DEV ONLY auth: trusts a user id sent by the client. Replace with real auth
    (session cookie or JWT) before anything is public. The id must be a stable, safe
    string because it names the user's sandbox container and volume."""
    uid = x_user_id or user_id
    if not uid or not uid.replace("-", "").replace("_", "").isalnum() or len(uid) > 40:
        raise HTTPException(401, "missing or invalid user id")
    return uid


def check_project(project_id: str) -> str:
    if not SLUG.match(project_id):
        raise HTTPException(422, "project_id must be lowercase letters, digits and dashes (max 30)")
    return project_id


class RunRequest(BaseModel):
    prompt: str = Field(min_length=1, max_length=20000)
    project_id: str = "main"  # one workspace + one chat history per project
    # auto: plan a new project, build one that has an approved plan. plan: (re)plan. build: build the plan.
    mode: Literal["auto", "plan", "build"] = "auto"


@app.get("/health")
async def health():
    await r.ping()
    return {"ok": True}


@app.post("/runs")
async def create_run(body: RunRequest, uid: str = Depends(current_user)):
    project_id = check_project(body.project_id)
    sandbox_id = f"{uid}-{project_id}"
    run_id = uuid.uuid4().hex

    # One active run per project. The worker releases this lock when the run ends;
    # the expiry is a safety net in case a worker dies.
    got_lock = await r.set(config.lock_key(sandbox_id), run_id, nx=True, ex=60 * 60)
    if not got_lock:
        raise HTTPException(409, "this project already has a run in progress")

    await r.set(config.owner_key(run_id), uid, ex=60 * 60 * 24)
    await r.rpush(
        config.JOBS_QUEUE,
        json.dumps(
            {"run_id": run_id, "user_id": uid, "project_id": project_id, "prompt": body.prompt, "mode": body.mode}
        ),
    )
    return {"run_id": run_id, "project_id": project_id}


@app.get("/runs/{run_id}/events")
async def stream_events(
    run_id: str,
    request: Request,
    uid: str = Depends(current_user),
    last_event_id: str = Header(default="0"),
    poll: int = 0,
):
    """Server-Sent Events. Uses a Redis Stream, so a client that reconnects with
    Last-Event-ID replays everything it missed.

    poll=1 is for tunnels that buffer a streaming response until it ends (Cloudflare quick
    tunnels do): each response sends what is ready (waiting up to 2 s) and then closes, and
    the browser's EventSource reconnects with Last-Event-ID, which makes it a long poll."""
    if await r.get(config.owner_key(run_id)) != uid:
        raise HTTPException(404, "run not found")

    async def gen():
        last = last_event_id or "0"
        if poll:
            yield "retry: 250\n\n"
            resp = await r.xread({config.stream_key(run_id): last}, block=2000, count=500)
            for _, entries in resp or []:
                for entry_id, fields in entries:
                    yield f"id: {entry_id}\nevent: {fields['type']}\ndata: {fields['data']}\n\n"
            return
        while True:
            if await request.is_disconnected():
                return
            resp = await r.xread({config.stream_key(run_id): last}, block=15000, count=50)
            if not resp:
                yield ": keepalive\n\n"  # stops proxies closing an idle connection
                continue
            for _, entries in resp:
                for entry_id, fields in entries:
                    last = entry_id
                    yield f"id: {entry_id}\nevent: {fields['type']}\ndata: {fields['data']}\n\n"
                    if fields["type"] in ("done", "error"):
                        return

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class PreviewRequest(BaseModel):
    project_id: str = "main"


@app.post("/preview")
async def create_preview(
    body: PreviewRequest, request: Request, uid: str = Depends(current_user)
):
    """Returns a URL that shows the app running in the project's sandbox."""
    direct = config.PREVIEW_URL
    if not direct and config.PREVIEW_URL_FILE and os.path.exists(config.PREVIEW_URL_FILE):
        direct = open(config.PREVIEW_URL_FILE).read().strip()
    if direct and not config.PREVIEW_DOMAIN:
        check_project(body.project_id)
        # Sandboxes share the host network here, so the app (if any) listens on localhost.
        try:
            async with httpx.AsyncClient(timeout=3, trust_env=False) as c:
                await c.get(f"http://127.0.0.1:{config.PREVIEW_PORT}/")
        except httpx.HTTPError:
            raise HTTPException(409, f"Nothing is running on port {config.PREVIEW_PORT} yet. Ask the agent to start the app.")
        return {"url": direct.rstrip("/") + "/", "expires_in": 60 * 60}
    if not config.PREVIEW_DOMAIN:
        raise HTTPException(501, "PREVIEW_DOMAIN is not configured on the server")
    project_id = check_project(body.project_id)
    token = secrets.token_hex(8)  # unguessable: the link itself is the access control
    await r.set(config.preview_key(token), f"{uid}-{project_id}", ex=60 * 60 * 24)

    port = request.url.port  # same port as the API, so one open port serves both
    port_part = f":{port}" if port else ""
    return {"url": f"http://{token}.{config.PREVIEW_DOMAIN}{port_part}/", "expires_in": 60 * 60 * 24}
