"""Worker: pulls jobs from Redis and runs one Strands agent per job.

Run with:  python -m app.worker
Scale by starting more worker processes (or machines). They share the same queue.
"""
from strands.types.exceptions import MaxTokensReachedException
import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor

from . import config, harness, sandbox
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
    for attempt in range(4):
        try:
            return agent(prompt)
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
        sandbox.snapshot(ctx.sandbox_id)
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
