"""Live preview: proxies browser requests to the dev server running inside a user's sandbox.

How it works
  1. The front end calls POST /preview (authenticated). We create a random token stored in Redis
     that maps to the project's sandbox, and return a URL like  http://<token>.<PREVIEW_DOMAIN>:8000/
  2. The browser opens that URL (or puts it in an iframe). The request still lands on this API server,
     because every subdomain of PREVIEW_DOMAIN points at it.
  3. A middleware (see api.py) sees the Host header, looks the token up, finds where the sandbox's
     app is reachable, and forwards the request there:
       - bridge networking (production): the worker records host:port of the sandbox's published
         PREVIEW_PORT in Redis (sandbox:<id>:addr), so the API can run on another machine (Fargate)
         and still reach any worker host over the VPC;
       - otherwise (legacy dev): the container's IP from the local Docker daemon.

Why subdomains and not /preview/<id>/ paths: apps use absolute links like /static/app.css, which
break under a path prefix. A subdomain gives each app its own root, like Replit does.

Limits of this version
  - Plain HTTP only. WebSockets (for example hot reload in Vite) are not proxied yet.
  - The token is a secret link: anyone who has it can view the preview until it expires.
  - Without a registered address it falls back to the local Docker daemon (same-host setups only).
"""
import asyncio
import time

import docker
import httpx
from starlette.requests import Request
from starlette.responses import HTMLResponse, Response

from . import config

_dc = None
_http = httpx.AsyncClient(timeout=30, follow_redirects=False)

# Headers that must not be copied between the two HTTP hops.
_SKIP_REQUEST = {"host", "connection", "content-length", "accept-encoding"}
_SKIP_RESPONSE = {"connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"}

_ip_cache: dict[str, tuple[float, str]] = {}


def _lookup_ip(sandbox_id: str) -> str:
    global _dc
    if _dc is None:
        _dc = docker.from_env()  # lazily: the API may run where there is no Docker daemon
    c = _dc.containers.get(f"sbx-{sandbox_id}")
    nets = c.attrs["NetworkSettings"]["Networks"]
    return next(iter(nets.values()))["IPAddress"]


async def _container_ip(sandbox_id: str) -> str:
    cached = _ip_cache.get(sandbox_id)
    if cached and time.time() - cached[0] < 10:
        return cached[1]
    ip = await asyncio.to_thread(_lookup_ip, sandbox_id)  # blocking Docker call
    _ip_cache[sandbox_id] = (time.time(), ip)
    return ip


def _message(title: str, body: str, status: int) -> HTMLResponse:
    html = (
        "<!doctype html><meta charset=utf-8>"
        "<body style='font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#333'>"
        f"<h2>{title}</h2><p>{body}</p></body>"
    )
    return HTMLResponse(html, status_code=status)


async def proxy(request: Request, token: str, r) -> Response:
    sandbox_id = await r.get(config.preview_key(token))
    if not sandbox_id:
        return _message("Preview link expired", "Ask for a new preview link.", 404)

    target = await r.get(config.sandbox_addr_key(sandbox_id))
    if not target:
        try:
            target = f"{await _container_ip(sandbox_id)}:{config.PREVIEW_PORT}"
        except Exception:  # noqa: BLE001 - NotFound, no Docker daemon here, no network
            return _message("Sandbox is not running", "Start a run first so the sandbox exists.", 502)

    url = f"http://{target}{request.url.path}"
    if request.url.query:
        url += f"?{request.url.query}"

    headers = {k: v for k, v in request.headers.items() if k.lower() not in _SKIP_REQUEST}
    headers["x-forwarded-host"] = request.headers.get("host", "")
    try:
        upstream = await _http.request(request.method, url, headers=headers, content=await request.body())
    except httpx.TransportError:
        return _message(
            "Nothing is running on the preview port yet",
            f"The app has to listen on 0.0.0.0:{config.PREVIEW_PORT}. Ask the agent to start it.",
            502,
        )

    resp = Response(content=upstream.content, status_code=upstream.status_code)
    for k, v in upstream.headers.multi_items():  # multi_items keeps repeated Set-Cookie headers
        lk = k.lower()
        if lk in _SKIP_RESPONSE:
            continue
        if lk == "set-cookie":
            resp.headers.append(k, v)  # several cookies are allowed
        else:
            resp.headers[k] = v  # replace Starlette's default (for example content-type)
    return resp
