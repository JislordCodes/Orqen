"""Per-run context. Tools and the agent callback use it to publish events that the
API server streams to the browser (via Redis Streams, so reconnects can replay)."""
import json
import threading

import redis

from .config import REDIS_URL, stream_key



def get_redis():
    return redis.Redis(
        host='localhost',
        port='6379',
        socket_timeout=10,  # Must be greater than BLPOP timeout
        socket_connect_timeout=5,
    )

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
        self.edits = 0              # number of successful edits (resets the loop breaker)
        self.features_passed = 0    # features flipped to passing in the current session
        self.plan_state = ""        # planner: "submitted" | "questions"
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
