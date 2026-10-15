"""Worker: pulls jobs from Redis and runs one Strands agent per job.

Run with:  python -m app.worker
Scale by starting more worker processes (or machines). They share the same queue.
"""
import json
import logging
import threading
from concurrent.futures import ThreadPoolExecutor

from . import config
from .agent import build_agent
from .events import RunContext, get_redis

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("worker")


def run_job(job: dict) -> None:
    r = get_redis()
    ctx = RunContext(job["run_id"], job["user_id"], job.get("project_id", "main"), r)
    try:
        ctx.emit("status", {"state": "started"})
        agent = build_agent(ctx)
        result = agent(job["prompt"])  # blocking: runs the whole agent loop
        ctx.flush_text()
        ctx.emit("done", {"summary": str(result)[:2000]})
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
