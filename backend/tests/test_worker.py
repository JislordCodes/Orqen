import json

import fakeredis

from app import config, worker
from app.events import RunContext


def _ctx(r, mode="build"):
    ctx = RunContext("run1", "demo-user", "main", r)
    ctx.requeued = False
    ctx.mode = mode
    return ctx


def test_requeue_puts_job_first_and_keeps_lock():
    r = fakeredis.FakeRedis()
    r.rpush(config.JOBS_QUEUE, json.dumps({"run_id": "other"}))
    r.set(config.lock_key("demo-user-main"), "run1", ex=10)
    job = {"run_id": "run1", "user_id": "demo-user", "project_id": "main", "prompt": "build it", "mode": "auto"}
    ctx = _ctx(r)
    assert worker.requeue(job, ctx, r) is True
    assert worker.requeue(job, ctx, r) is True  # idempotent
    assert r.llen(config.JOBS_QUEUE) == 2
    first = json.loads(r.lindex(config.JOBS_QUEUE, 0))
    assert first["run_id"] == "run1" and first["attempt"] == 1 and first["mode"] == "build"
    assert r.get(config.lock_key("demo-user-main")) == b"run1" and r.ttl(config.lock_key("demo-user-main")) > 10
    types = [f[b"type"] for _, f in r.xrange(config.stream_key("run1"))]
    assert b"status" in types


def test_requeue_gives_up_after_max_attempts():
    r = fakeredis.FakeRedis()
    job = {"run_id": "run1", "user_id": "demo-user", "prompt": "x", "attempt": config.MAX_JOB_ATTEMPTS}
    assert worker.requeue(job, _ctx(r), r) is False
    assert r.llen(config.JOBS_QUEUE) == 0
    assert [f[b"type"] for _, f in r.xrange(config.stream_key("run1"))] == [b"error"]
