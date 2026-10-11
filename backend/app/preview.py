"""Live preview: proxies browser requests to the dev server running inside a user's sandbox.

How it works
  1. The front end calls POST /preview (authenticated). We create a random token stored in Redis
     that maps to the project's sandbox, and return a URL like  http://<token>.<PREVIEW_DOMAIN>:8000/
  2. The browser opens that URL (or puts it in an iframe). The request still lands on this API server,
     because every subdomain of PREVIEW_DOMAIN points at it.
  3. A middleware (see api.py) sees the Host header, looks the token up, finds the sandbox
     container's IP, and forwards the request to <ip>:PREVIEW_PORT.

Why subdomains and not /preview/<id>/ paths: apps use absolute links like /static/app.css, which
break under a path prefix. A subdomain gives each app its own root, like Replit does.

Limits of this version
  - Plain HTTP only. WebSockets (for example hot reload in Vite) are not proxied yet.
  - The token is a secret link: anyone who has it can view the preview until it expires.
  - It needs access to the Docker daemon, so it works when the API runs on the same host as the sandboxes.
"""
import asyncio
import time

import docker
import httpx
from docker.errors import NotFound
from starlette.requests import Request
from starlette.responses import HTMLResponse, Response

from . import config

_dc = docker.from_env()
_http = httpx.AsyncClient(timeout=30, follow_redirects=False)

# Headers that must not be copied between the two HTTP hops.
_SKIP_REQUEST = {"host", "connection", "content-length", "accept-encoding"}
_SKIP_RESPONSE = {"connection", "keep-alive", "transfer-encoding", "content-encoding", "content-length"}

_ip_cache: dict[str, tuple[float, str]] = {}


def _lookup_ip(sandbox_id: str) -> str:
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

    try:
        ip = await _container_ip(sandbox_id)
    except (NotFound, KeyError, StopIteration):
        return _message("Sandbox is not running", "Start a run first so the sandbox exists.", 502)

    url = f"http://{ip}:{config.PREVIEW_PORT}{request.url.path}"
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
