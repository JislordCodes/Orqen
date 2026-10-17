"""Worker: pulls jobs from Redis and runs one Strands agent per job.

Run with:  python -m app.worker
Scale by starting more worker processes (or machines). They share the same queue.
"""
import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor

from . import config, harness
from .agent import build_agent
from .events import RunContext, get_redis

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("worker")


def _choose_mode(job: dict, ctx: RunContext) -> str:
    """plan | build. "auto" plans a project that has no plan yet, otherwise builds."""
    mode = job.get("mode", "auto")
    if mode in ("plan", "build"):
        return mode
    return "build" if harness.has_plan(ctx.sandbox_id) else "plan"


def run_plan(job: dict, ctx: RunContext) -> None:
    ctx.emit("phase", {"phase": "planning"})
    agent = build_agent(ctx, "planner")
    result = agent(job["prompt"])
    ctx.flush_text()
    state = ctx.plan_state or "no_plan"
    ctx.emit("done", {"summary": str(result)[:2000], "state": "awaiting_approval" if state == "submitted" else state})


def run_build(job: dict, ctx: RunContext) -> None:
    """Feature-by-feature build across as many sessions as it takes (up to MAX_SESSIONS).
    A session that flips no feature to passing ends the run, so it never spins."""
    agent = build_agent(ctx, "builder")
    prompt = job["prompt"]
    result = None
    for session in range(1, config.MAX_SESSIONS + 1):
        ctx.new_session()
        ctx.emit("phase", {"phase": "building", "session": session, "max_sessions": config.MAX_SESSIONS})
        result = agent(prompt)
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


def run_job(job: dict) -> None:
    r = get_redis()
    ctx = RunContext(job["run_id"], job["user_id"], job.get("project_id", "main"), r)
    try:
        ctx.emit("status", {"state": "started"})
        if _choose_mode(job, ctx) == "plan":
            run_plan(job, ctx)
        else:
            run_build(job, ctx)
    except Exception as e:  # noqa: BLE001
        log.exception("run %s failed", job.get("run_id"))
        ctx.flush_text()
        ctx.emit("error", {"message": str(e)})
    finally:
        # Release the per-project lock, but only if it is still ours.
        key = config.lock_key(ctx.sandbox_id)
        # get_redis() returns bytes, so decode before comparing (otherwise the lock is
        # never released and the project stays blocked with HTTP 409 for an hour).
        held = r.get(key)
        if isinstance(held, bytes):
            held = held.decode()
        if held == ctx.run_id:
            r.delete(key)


def main() -> None:
    if not config.NEBIUS_API_KEY :
        raise SystemExit("NEBIUS_API_KEY  is not set (the worker needs it).")

    r = get_redis()
    slots = threading.Semaphore(config.MAX_CONCURRENT_RUNS)
    pool = ThreadPoolExecutor(max_workers=config.MAX_CONCURRENT_RUNS)

    def guarded(job: dict) -> None:
        try:
            run_job(job)
        finally:
            slots.release()

    log.info("worker ready (max %d concurrent runs)", config.MAX_CONCURRENT_RUNS)
    while True:
        slots.acquire()  # only take a job if we have capacity to run it
        item = r.blpop(config.JOBS_QUEUE, timeout=5)
        if not item:
            slots.release()
            continue
        _, raw = item
        job = json.loads(raw)
        log.info("starting run %s (user %s, project %s)", job["run_id"], job["user_id"], job.get("project_id", "main"))
        pool.submit(guarded, job)


if __name__ == "__main__":
    main()
