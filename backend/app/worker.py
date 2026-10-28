"""Worker: pulls jobs from Redis and runs one Strands agent per job.

Run with:  python -m app.worker
Scale by starting more worker processes (or machines). They share the same queue.

Shutdown (SIGTERM / SIGINT): stop taking jobs, give running jobs WORKER_SHUTDOWN_GRACE seconds to
finish, then cancel the rest at a safe point (Strands Agent.cancel), snapshot them and put them back
at the FRONT of the queue under the same run_id. The project lock stays with that run, so the browser
keeps streaming the same run and the next worker resumes it from the workspace and plan files.
A job is re-queued at most MAX_JOB_ATTEMPTS times.

Health: WORKER_HEALTH_PORT (0 = off) serves GET /health (process up) and GET /ready (Redis and the
Docker daemon answer). The worker also refreshes worker:<id>:heartbeat in Redis.
"""
import json
import logging
import os
import signal
import socket
import threading
import time
from concurrent.futures import ThreadPoolExecutor
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from strands.types.exceptions import MaxTokensReachedException

from . import config, harness, logging_setup, sandbox
from .agent import build_agent
from .events import RunContext, WorkerShutdown, get_redis

log = logging.getLogger("worker")

WORKER_ID = f"{socket.gethostname()}-{os.getpid()}"
_stopping = threading.Event()
_running: dict[str, tuple[dict, RunContext]] = {}
_running_lock = threading.Lock()
_requeue_lock = threading.Lock()


def _choose_mode(job: dict, ctx: RunContext) -> str:
    """plan | build. "auto" plans a project that has no plan yet, otherwise builds."""
    mode = job.get("mode", "auto")
    if mode in ("plan", "build"):
        return mode
    return "build" if harness.has_plan(ctx.sandbox_id) else "plan"


def run_plan(job: dict, ctx: RunContext) -> None:
    ctx.emit("phase", {"phase": "planning"})
    # A new plan may replace whatever is in this workspace, so keep a dated copy first.
    try:
        spec = sandbox.read_file(ctx.sandbox_id, harness.SPEC)
        title = spec.strip().splitlines()[0].lstrip("# ") if spec.strip() else ""
        if title:
            sandbox.archive(ctx.sandbox_id, title)
    except Exception:  # noqa: BLE001 - no plan yet, or archiving failed; never block planning
        pass
    agent = build_agent(ctx, "planner")
    result = _call(agent, job["prompt"], ctx)
    ctx.flush_text()
    state = ctx.plan_state or "no_plan"
    ctx.emit("done", {"summary": str(result)[:2000], "state": "awaiting_approval" if state == "submitted" else state})


def _call(agent, prompt: str, ctx: RunContext):
    """One agent call that survives the model hitting its output limit mid-file (Strands raises
    MaxTokensReachedException and keeps the partial turn): nudge it to write smaller pieces."""
    ctx.agent = agent  # lets shutdown cancel this call (ctx.cancel)
    for attempt in range(4):
        if ctx.cancelled.is_set():
            raise WorkerShutdown()
        try:
            result = agent(prompt)
            if ctx.cancelled.is_set():
                raise WorkerShutdown()
            return result
        except MaxTokensReachedException:
            if attempt == 3:
                raise
            ctx.flush_text()
            ctx.emit("text", {"text": "\n(Output limit hit mid-file; continuing in smaller pieces.)\n"})
            prompt = ("Your last reply was cut off by the output limit, so that tool call did not run. "
                      "Write big files in smaller parts: create a short file first, then extend it with str_replace, "
                      "keeping each tool call under about 300 lines. Continue from where you stopped.")


def run_build(job: dict, ctx: RunContext) -> None:
    """Feature-by-feature build across as many sessions as it takes (up to MAX_SESSIONS).
    A session that flips no feature to passing ends the run, so it never spins."""
    agent = build_agent(ctx, "builder")
    prompt = job["prompt"]
    result = None
    for session in range(1, config.MAX_SESSIONS + 1):
        ctx.new_session()
        ctx.emit("phase", {"phase": "building", "session": session, "max_sessions": config.MAX_SESSIONS})
        result = _call(agent, prompt, ctx)
        ctx.flush_text()
        feats = harness.read_features(ctx.sandbox_id)
        if not feats:
            break  # chat-style run on a project without a plan
        todo = harness.failing(feats)
        ctx.emit("features", harness.feature_summary(feats))
        if not todo or ctx.features_passed == 0:
            break
        prompt = (
            f"Continue with the next session. {len(feats) - len(todo)}/{len(feats)} features pass. "
            f"Next failing: {todo[0]['id']} {todo[0].get('title', '')}. Read .orqen/progress.md, then keep going."
        )
    feats = harness.read_features(ctx.sandbox_id) or []
    summary = harness.feature_summary(feats) if feats else {}
    ctx.emit("done", {"summary": str(result)[:2000], "state": "built", **({"passing": summary["passing"], "total": summary["total"]} if feats else {})})


def requeue(job: dict, ctx: RunContext, r) -> bool:
    """Put a run cut short by shutdown back at the front of the queue (same run_id, lock kept).
    Returns False (and ends the run with an error) once MAX_JOB_ATTEMPTS is reached."""
    with _requeue_lock:
        if getattr(ctx, "requeued", False):
            return True
        attempt = int(job.get("attempt", 0)) + 1
        if attempt > config.MAX_JOB_ATTEMPTS:
            ctx.emit("error", {"message": "The server restarted too many times during this run. Send the prompt again."})
            return False
        resumed = dict(job, attempt=attempt)
        if getattr(ctx, "mode", "") == "build":
            resumed["mode"] = "build"
            resumed["prompt"] = (
                "The previous worker was restarted in the middle of this run. Read .orqen/progress.md and "
                "features.json, restart any processes you need (they may be gone), and continue the build. "
                f"The original request was: {job['prompt'][:4000]}"
            )
        ctx.flush_text()
        ctx.emit("status", {"state": "requeued", "attempt": attempt})
        ctx.emit("text", {"text": "\n(The server is restarting; this run continues on another worker.)\n"})
        r.lpush(config.JOBS_QUEUE, json.dumps(resumed))
        r.expire(config.lock_key(ctx.sandbox_id), 60 * 60)  # the lock now belongs to the resumed job
        ctx.requeued = True
        log.info("re-queued run", extra={"run_id": ctx.run_id, "attempt": attempt})
        return True


def run_job(job: dict) -> None:
    r = get_redis()
    ctx = RunContext(job["run_id"], job["user_id"], job.get("project_id", "main"), r)
    ctx.requeued = False
    with _running_lock:
        _running[ctx.run_id] = (job, ctx)
    try:
        ctx.emit("status", {"state": "started"})
        sandbox.get_container(ctx.sandbox_id)
        sandbox.register_addr(ctx.sandbox_id)
        ctx.mode = _choose_mode(job, ctx)
        if ctx.mode == "plan":
            run_plan(job, ctx)
        else:
            run_build(job, ctx)
    except WorkerShutdown:
        requeue(job, ctx, r)
    except Exception as e:  # noqa: BLE001
        if ctx.cancelled.is_set():
            requeue(job, ctx, r)
        else:
            log.exception("run %s failed", job.get("run_id"))
            ctx.flush_text()
            ctx.emit("error", {"message": str(e)})
    finally:
        with _running_lock:
            _running.pop(ctx.run_id, None)
        sandbox.snapshot(ctx.sandbox_id)
        if ctx.requeued:
            return  # the lock stays with the re-queued run
        # Release the per-project lock, but only if it is still ours.
        key = config.lock_key(ctx.sandbox_id)
        # get_redis() returns bytes, so decode before comparing (otherwise the lock is
        # never released and the project stays blocked with HTTP 409 for an hour).
        held = r.get(key)
        if isinstance(held, bytes):
            held = held.decode()
        if held == ctx.run_id:
            r.delete(key)


def _ready() -> tuple[bool, dict]:
    checks = {}
    try:
        checks["redis"] = "ok" if get_redis().ping() else "error"
    except Exception as e:  # noqa: BLE001
        checks["redis"] = f"error: {str(e)[:200]}"
    checks["docker"] = "ok" if sandbox.docker_ok() else "error"
    checks["running"] = len(_running)
    checks["stopping"] = _stopping.is_set()
    ok = checks["redis"] == "ok" and checks["docker"] == "ok" and not _stopping.is_set()
    return ok, checks


class _Health(BaseHTTPRequestHandler):
    def do_GET(self):  # noqa: N802
        if self.path.startswith("/health"):
            code, body = 200, {"ok": True, "worker": WORKER_ID}
        elif self.path.startswith("/ready"):
            ok, checks = _ready()
            code, body = (200 if ok else 503), {"ok": ok, **checks}
        else:
            code, body = 404, {"detail": "not found"}
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *args):  # silence per-request logging
        pass


def _heartbeat() -> None:
    while not _stopping.is_set():
        try:
            get_redis().set(config.worker_heartbeat_key(WORKER_ID),
                            json.dumps({"running": len(_running), "ts": time.time()}),
                            ex=config.WORKER_HEARTBEAT_TTL)
        except Exception:  # noqa: BLE001
            log.warning("heartbeat failed", exc_info=True)
        _stopping.wait(config.WORKER_HEARTBEAT_TTL / 3)


def _on_signal(signum, _frame) -> None:
    if not _stopping.is_set():
        log.info("shutdown requested", extra={"signal": signal.Signals(signum).name, "running": len(_running)})
    _stopping.set()


def _drain(r) -> None:
    """After SIGTERM: wait for running jobs, then cancel and re-queue whatever is left."""
    deadline = time.time() + config.WORKER_SHUTDOWN_GRACE
    while _running and time.time() < deadline:
        time.sleep(1)
    if not _running:
        return
    with _running_lock:
        leftover = list(_running.values())
    log.info("grace period over; cancelling runs", extra={"count": len(leftover)})
    for _, ctx in leftover:
        ctx.cancel()
    # Cancelled agents stop at their next safe point and re-queue themselves (run_job).
    deadline = time.time() + 30
    while _running and time.time() < deadline:
        time.sleep(1)
    with _running_lock:
        stuck = list(_running.values())
    for job, ctx in stuck:  # e.g. blocked inside a long tool call: re-queue from here
        requeue(job, ctx, r)
        try:
            sandbox.snapshot(ctx.sandbox_id)
        except Exception:  # noqa: BLE001
            pass


def main() -> None:
    logging_setup.setup("worker")
    if not config.NEBIUS_API_KEY:
        raise SystemExit("NEBIUS_API_KEY is not set (the worker needs it).")

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    port = int(os.getenv("WORKER_HEALTH_PORT", "0"))
    if port:
        srv = ThreadingHTTPServer(("0.0.0.0", port), _Health)
        threading.Thread(target=srv.serve_forever, daemon=True, name="health").start()
    threading.Thread(target=_heartbeat, daemon=True, name="heartbeat").start()

    r = get_redis()
    slots = threading.Semaphore(config.MAX_CONCURRENT_RUNS)
    pool = ThreadPoolExecutor(max_workers=config.MAX_CONCURRENT_RUNS)

    def guarded(job: dict) -> None:
        try:
            run_job(job)
        finally:
            slots.release()

    log.info("worker ready", extra={"worker": WORKER_ID, "max_concurrent_runs": config.MAX_CONCURRENT_RUNS,
                                    "sandbox_network": config.SANDBOX_NETWORK})
    while not _stopping.is_set():
        if not slots.acquire(timeout=1):  # only take a job if we have capacity to run it
            continue
        try:
            item = r.blpop(config.JOBS_QUEUE, timeout=2)
        except Exception:  # noqa: BLE001 - Redis blip: back off and retry
            slots.release()
            log.warning("redis error while waiting for jobs", exc_info=True)
            time.sleep(2)
            continue
        if not item:
            slots.release()
            continue
        _, raw = item
        job = json.loads(raw)
        if _stopping.is_set():  # signal arrived while we were blocked: hand the job back untouched
            r.lpush(config.JOBS_QUEUE, raw)
            slots.release()
            break
        log.info("starting run", extra={"run_id": job["run_id"], "user": job["user_id"],
                                        "project": job.get("project_id", "main"), "attempt": job.get("attempt", 0)})
        pool.submit(guarded, job)

    _drain(r)
    try:
        r.delete(config.worker_heartbeat_key(WORKER_ID))
    except Exception:  # noqa: BLE001
        pass
    log.info("worker stopped")
    logging.shutdown()
    # Threads stuck in a model call cannot be joined; their jobs are already re-queued.
    os._exit(0)


if __name__ == "__main__":
    main()
