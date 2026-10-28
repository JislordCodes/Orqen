"""Per-run context. Tools and the agent callback use it to publish events that the
API server streams to the browser (via Redis Streams, so reconnects can replay)."""
import json
import threading

import redis

from .config import REDIS_PASSWORD, REDIS_URL, stream_key

_pool: "redis.ConnectionPool | None" = None


def get_redis() -> redis.Redis:
    """Sync Redis client for the worker (bytes responses). Honours REDIS_URL (redis:// or rediss://
    for TLS) and REDIS_PASSWORD. Clients share one thread-safe connection pool."""
    global _pool
    if _pool is None:
        _pool = redis.ConnectionPool.from_url(
            REDIS_URL,
            password=REDIS_PASSWORD,
            socket_timeout=10,  # Must be greater than BLPOP timeout
            socket_connect_timeout=5,
            health_check_interval=30,
        )
    return redis.Redis(connection_pool=_pool)

class WorkerShutdown(Exception):
    """Raised by the worker when a run was cut short by shutdown; the job is re-queued."""


class RunContext:
    def __init__(self, run_id: str, user_id: str, project_id: str, r: redis.Redis):
        self.run_id = run_id
        self.user_id = user_id
        self.project_id = project_id
        self.r = r
        self.tool_calls = 0
        # Harness state (see harness.py / tools.py)
        self.dirty = False          # files edited since the last green run_checks
        self.checks_green = False   # last run_checks passed
        self.passes_since_checks = 0  # features marked passing since the last green run_checks
        self.edits = 0              # number of successful edits (resets the loop breaker)
        self.features_passed = 0    # features flipped to passing in the current session
        self.plan_state = ""        # planner: "submitted" | "questions"
        # Set by the worker on shutdown (see worker.py): the current agent is cancelled at its next
        # safe point (Strands Agent.cancel) and the job is re-queued instead of being reported done.
        self.cancelled = threading.Event()
        self.agent = None           # the Strands agent currently running, so shutdown can cancel it
        self._buf = ""
        # Strands may run several tools concurrently in threads, so guard shared state.
        self._lock = threading.Lock()

    @property
    def sandbox_id(self) -> str:
        """Names the project's container, volume and chat session."""
        return f"{self.user_id}-{self.project_id}"

    def emit(self, type_: str, data: dict) -> None:
        self.r.xadd(
            stream_key(self.run_id),
            {"type": type_, "data": json.dumps(data)},
            maxlen=5000,
            approximate=True,
        )

    def cancel(self) -> None:
        self.cancelled.set()
        agent = self.agent
        if agent is not None:
            try:
                agent.cancel()
            except Exception:  # noqa: BLE001 - older Strands without cancel(): stop at the next job boundary
                pass

    def new_session(self) -> None:
        """Called by the worker before each builder session: fresh tool budget and progress count."""
        with self._lock:
            self.tool_calls = 0
            self.features_passed = 0

    def next_tool_call(self) -> int:
        with self._lock:
            self.tool_calls += 1
            return self.tool_calls

    # Text arrives token by token; batch it so we don't write one Redis entry per token.
    def emit_text(self, chunk: str) -> None:
        with self._lock:
            self._buf += chunk
            should_flush = len(self._buf) >= 60 or "\n" in chunk
        if should_flush:
            self.flush_text()

    def flush_text(self) -> None:
        with self._lock:
            text, self._buf = self._buf, ""
        if text.strip():  # drop whitespace-only chunks (they are just noise for the UI)
            self.emit("text", {"text": text})
