"""Browser smoke test: load the running app in headless Chromium and catch what unit
tests and typecheck miss (a blank page from a runtime error, a crashing route).

Runs on the worker host. With host networking the app is on localhost:PREVIEW_PORT; with bridge
networking it is on the host port Docker published for the sandbox (sandbox.preview_addr).
Skipped (never failed) when Chromium is missing."""
import os
import re
import shutil
import socket
import subprocess

from . import config, sandbox

CHROMIUM = os.getenv("CHROMIUM_BIN", "") or shutil.which("chromium") or shutil.which("chromium-browser") or ""
_ROOT_EMPTY = re.compile(r'<div id="root">\s*</div>')
_CONSOLE = re.compile(r'INFO:CONSOLE[^\]]*\] "(.*?)", source: (\S+)')


def _listening(host: str, port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(1)
        return s.connect_ex((host, port)) == 0


def _routes(uid: str) -> list[str]:
    paths = ["/"]
    _, out = sandbox.sh(uid, "cat frontend/src/App.tsx frontend/src/main.tsx frontend/src/router.tsx 2>/dev/null", timeout=10)
    for p in re.findall(r'path[=:]\s*["\'](/[A-Za-z0-9_\-/]*)["\']', out):
        if p not in paths:
            paths.append(p)
    return paths[:8]


def check(uid: str) -> tuple[bool, str]:
    """(ok, report). ok is True when the check is skipped."""
    port = config.PREVIEW_PORT
    if not CHROMIUM or os.getenv("UI_CHECK", "1") == "0":
        return True, "UI check skipped (no browser on this host)."
    addr = sandbox.preview_addr(uid) or ("127.0.0.1", port)
    host, host_port = addr
    if not _listening(host, host_port):
        return False, (f"UI check: nothing is serving on port {port}. Start the frontend as process \"web\" "
                       "(npm run build, then vite preview on that port) and the API as \"api\", then run_checks again.")
    problems, seen = [], []
    for path in _routes(uid):
        try:
            p = subprocess.run(
                [CHROMIUM, "--headless=new", "--no-sandbox", "--disable-gpu", "--no-proxy-server",
                 "--enable-logging=stderr", "--v=0", "--virtual-time-budget=6000", "--window-size=390,844",
                 "--dump-dom", f"http://{host}:{host_port}{path}"],
                capture_output=True, text=True, timeout=45,
            )
        except subprocess.TimeoutExpired:
            problems.append(f"{path}: the page did not finish loading in 45 s")
            continue
        errs = [m[0] for m in _CONSOLE.findall(p.stderr) if re.search(r"error|uncaught|failed", m[0], re.I)]
        if errs:
            problems.append(f"{path}: browser console errors: " + " | ".join(dict.fromkeys(errs))[:600])
        if _ROOT_EMPTY.search(p.stdout) or len(re.sub(r"<[^>]+>", "", p.stdout).strip()) < 20:
            problems.append(f"{path}: the page rendered blank (nothing inside #root). The user sees a white screen.")
        seen.append(path)
    if problems:
        return False, "UI check FAILED in a real browser (390x844):\n- " + "\n- ".join(problems)
    return True, f"UI check passed: {', '.join(seen)} render with no console errors."
