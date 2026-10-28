"""FastAPI server. It never runs the agent: it enqueues jobs, relays events, and proxies previews.

Run with:  uvicorn app.api:app --host 0.0.0.0 --port 8000
"""
import asyncio
import json
import logging
import os
import re
import secrets
import time
import uuid
from typing import Literal

import httpx
import redis.asyncio as aioredis
from fastapi import Depends, FastAPI, Header, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from pydantic import BaseModel, Field

from . import config, logging_setup, preview, snapshots
from .auth import current_user

logging_setup.setup("api")
log = logging.getLogger("api")

app = FastAPI(title="Orqen API")

r = aioredis.from_url(
    config.REDIS_URL,
    password=config.REDIS_PASSWORD,
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


@app.middleware("http")
async def access_log(request: Request, call_next):
    """One structured line per API request (SSE streams are logged when they start)."""
    start = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception:
        log.exception("unhandled error", extra={"method": request.method, "path": request.url.path})
        return JSONResponse({"detail": "internal error"}, status_code=500)
    if request.url.path not in ("/health", "/live", "/ready"):
        log.info("request", extra={
            "method": request.method, "path": request.url.path, "status": response.status_code,
            "ms": round((time.perf_counter() - start) * 1000, 1),
            "ip": request.headers.get("x-forwarded-for", request.client.host if request.client else ""),
        })
    return response


# Added after the preview middleware so CORS headers wrap API responses.
# Origins come from CORS_ORIGINS (comma-separated) and optionally CORS_ORIGIN_REGEX.
app.add_middleware(
    CORSMiddleware,
    allow_origins=config.CORS_ORIGINS,
    allow_origin_regex=config.CORS_ORIGIN_REGEX,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type", "X-User-Id", "Last-Event-ID"],
    max_age=600,
)

log.info("api starting", extra={"auth_mode": config.AUTH_MODE, "cors_origins": ",".join(config.CORS_ORIGINS),
                                 "preview_domain": config.PREVIEW_DOMAIN, "snapshot_s3": bool(config.SNAPSHOT_S3_BUCKET)})


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
    """Liveness: the process answers. Kept backwards compatible ({"ok": true}); it also pings Redis
    so the dev UI's "Test connection" still means "the backend works". Load balancers should use
    /live (no dependencies) or /ready."""
    try:
        await r.ping()
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"ok": False, "redis": str(e)[:200]}, status_code=503)
    return {"ok": True}


@app.get("/live")
async def live():
    """Pure liveness for container health checks: no dependencies, so a Redis blip never restarts tasks."""
    return {"ok": True}


@app.get("/ready")
async def ready():
    """Readiness: Redis answers. Also reports live workers (from their heartbeats) without failing on
    them, since the API can serve reads and queue runs while workers restart."""
    checks: dict = {}
    ok = True
    try:
        await r.ping()
        checks["redis"] = "ok"
    except Exception as e:  # noqa: BLE001
        ok = False
        checks["redis"] = f"error: {str(e)[:200]}"
    if ok:
        workers = [k async for k in r.scan_iter(match="worker:*:heartbeat", count=100)]
        checks["workers"] = len(workers)
        checks["queue_depth"] = await r.llen(config.JOBS_QUEUE)
    return JSONResponse({"ok": ok, **checks}, status_code=200 if ok else 503)


@app.get("/_caddy/ask")
async def caddy_ask(domain: str = ""):
    """Caddy on-demand TLS gate (docker-compose.prod.yml): only issue certificates for the API host
    and for preview subdomains that map to a live preview token. Not useful to browsers."""
    domain = domain.lower().strip(".")
    if config.PREVIEW_DOMAIN and domain.endswith("." + config.PREVIEW_DOMAIN):
        token = domain[: -len(config.PREVIEW_DOMAIN) - 1]
        if re.fullmatch(r"[a-f0-9]{16}", token) and await r.exists(config.preview_key(token)):
            return Response(status_code=200)
    return Response(status_code=404)


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
    # Server-side record of the user's projects and runs, so any browser (or a new tunnel URL,
    # whose localStorage is empty) can list them with GET /projects.
    await r.lpush(f"runs:{sandbox_id}", json.dumps({"run_id": run_id, "prompt": body.prompt[:2000], "mode": body.mode, "ts": time.time()}))
    await r.ltrim(f"runs:{sandbox_id}", 0, 49)
    await r.zadd(f"projects:{uid}", {project_id: time.time()})
    await r.rpush(
        config.JOBS_QUEUE,
        json.dumps(
            {"run_id": run_id, "user_id": uid, "project_id": project_id, "prompt": body.prompt, "mode": body.mode}
        ),
    )
    return {"run_id": run_id, "project_id": project_id}


@app.get("/projects")
async def list_projects(uid: str = Depends(current_user)):
    """The user's projects, known from runs and durable snapshots, with recent runs (newest first)
    and the active run if one holds the project lock. The UI merges this into its local list."""
    ids: dict[str, float] = {p: ts for p, ts in await r.zrange(f"projects:{uid}", 0, -1, withscores=True)}
    # Snapshots on the local SNAPSHOT_DIR and/or S3 (blocking I/O, so off the event loop).
    snaps = await asyncio.to_thread(snapshots.list_projects, uid)
    for pid, (mtime, _title) in snaps.items():
        if SLUG.match(pid):
            ids[pid] = max(ids.get(pid, 0), mtime)
    out = []
    for pid, ts in sorted(ids.items(), key=lambda kv: -kv[1]):
        sid = f"{uid}-{pid}"
        runs = [json.loads(x) for x in await r.lrange(f"runs:{sid}", 0, 19)]
        out.append({
            "id": pid,
            "name": snaps.get(pid, (0, ""))[1] or pid.replace("-", " ").capitalize(),
            "updated_at": ts,
            "active_run_id": await r.get(config.lock_key(sid)),
            "runs": runs,
        })
    return {"projects": out}


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
    await r.set(config.preview_key(token), f"{uid}-{project_id}", ex=config.PREVIEW_TTL)

    if config.PREVIEW_SCHEME == "https":
        # Behind a TLS-terminating proxy (ALB / Caddy) with a wildcard certificate: no port.
        return {"url": f"https://{token}.{config.PREVIEW_DOMAIN}/", "expires_in": config.PREVIEW_TTL}
    port = request.url.port  # same port as the API, so one open port serves both
    port_part = f":{port}" if port else ""
    return {"url": f"http://{token}.{config.PREVIEW_DOMAIN}{port_part}/", "expires_in": config.PREVIEW_TTL}
