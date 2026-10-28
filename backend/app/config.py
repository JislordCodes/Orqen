"""Central configuration. Everything comes from environment variables (.env in dev)."""
import os

from dotenv import load_dotenv

load_dotenv()

def _bool(name: str, default: bool = False) -> bool:
    return os.getenv(name, "1" if default else "0").strip().lower() in ("1", "true", "yes", "on")


def _list(name: str, default: str = "") -> list[str]:
    return [x.strip() for x in os.getenv(name, default).split(",") if x.strip()]


# "dev" keeps every dev default; "production" only changes defaults that are safe to change
# (JSON logs). Everything security-relevant is still set explicitly (see docs/ENV.md).
APP_ENV = os.getenv("APP_ENV", "dev")

# Redis. Use rediss://host:6379 for TLS (ElastiCache in-transit encryption). REDIS_PASSWORD is
# the AUTH token; kept separate so it can come from a secret store without rewriting the URL.
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")
REDIS_PASSWORD = os.getenv("REDIS_PASSWORD", "") or None

# Logging: LOG_FORMAT=json emits one JSON object per line (CloudWatch / Loki friendly).
LOG_LEVEL = os.getenv("LOG_LEVEL", "INFO")
LOG_FORMAT = os.getenv("LOG_FORMAT", "json" if APP_ENV == "production" else "text")

# CORS: comma-separated exact origins, plus an optional regex (e.g. Vercel preview deployments:
# ^https://orqen-[a-z0-9-]+-yourteam\.vercel\.app$).
CORS_ORIGINS = _list("CORS_ORIGINS", "http://localhost:3000,http://localhost:5173,http://localhost:4173")
CORS_ORIGIN_REGEX = os.getenv("CORS_ORIGIN_REGEX", "") or None

# Auth. dev: trust X-User-Id / ?user_id= (current behaviour, never expose publicly).
#       jwt: verify "Authorization: Bearer <JWT>" (or ?access_token= for EventSource) against a JWKS.
AUTH_MODE = os.getenv("AUTH_MODE", "dev").lower()
JWT_JWKS_URL = os.getenv("JWT_JWKS_URL", "") or os.getenv("JWKS_URL", "")
JWT_ISSUER = os.getenv("JWT_ISSUER", "")
JWT_AUDIENCE = os.getenv("JWT_AUDIENCE", "")
JWT_ALGORITHMS = _list("JWT_ALGORITHMS", "RS256")
JWT_USER_CLAIM = os.getenv("JWT_USER_CLAIM", "sub")

# Only the WORKER needs this key. The API server never touches the LLM.
NEBIUS_API_KEY = os.getenv("NEBIUS_API_KEY")
BASE_URL = os.getenv("BASE_URL")
MODEL_ID = os.getenv("MODEL_ID", "")
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "32000"))  # 8192 cut GLM-5.3 off mid-file
# Context window of MODEL_ID in tokens; drives proactive summarisation (agent.py).
CONTEXT_WINDOW = int(os.getenv("CONTEXT_WINDOW", "131072"))
# Optional stronger reasoning model for the planner (e.g. moonshotai/Kimi-K3). Empty = MODEL_ID.
PLANNER_MODEL_ID = os.getenv("PLANNER_MODEL_ID", "")

# Sandbox (one Docker container + one volume per user)
SANDBOX_IMAGE = os.getenv("SANDBOX_IMAGE", "appbuilder-sandbox:latest")
# "bridge" lets npm/pip install work in dev. In production use an egress proxy
# that only allows package registries, or "none" if you pre-bake dependencies.
# "host": every sandbox shares the host network (the single-box dev setup in start-stack.sh): apps listen
#         on host ports 3000/8001, so only one project can be previewed at a time.
# "bridge" (or the name of any user-defined Docker network): each sandbox gets its own network
#         namespace and its PREVIEW_PORT is published on a random free host port, recorded in Redis
#         (sandbox:<id>:addr), so many previews run at once and the API can proxy to any worker host.
SANDBOX_NETWORK = os.getenv("SANDBOX_NETWORK", "bridge")
# Address other machines (the API / preview proxy) use to reach this worker host's published ports.
# On EC2 the worker's user-data sets it to the instance's private IP. Local dev: 127.0.0.1.
SANDBOX_ADVERTISE_HOST = os.getenv("SANDBOX_ADVERTISE_HOST", "127.0.0.1")
# Interface the published sandbox ports bind to ("0.0.0.0" so the API can reach them over the VPC;
# keep the security group closed to everything except the API).
SANDBOX_PUBLISH_IP = os.getenv("SANDBOX_PUBLISH_IP", "0.0.0.0")
# Optional OCI runtime for stronger isolation, e.g. "runsc" (gVisor) or "sysbox-runc". Empty = runc.
SANDBOX_RUNTIME = os.getenv("SANDBOX_RUNTIME", "")
SANDBOX_MEM = os.getenv("SANDBOX_MEM", "3g")
SANDBOX_CPUS = float(os.getenv("SANDBOX_CPUS", "1.0"))

# Worker limits
MAX_CONCURRENT_RUNS = int(os.getenv("MAX_CONCURRENT_RUNS", "4"))
MAX_TOOL_CALLS = int(os.getenv("MAX_TOOL_CALLS", "80"))  # hard budget per session
# A build run keeps starting fresh sessions while features are failing and the last
# session made progress, up to this many sessions (each with MAX_TOOL_CALLS).
MAX_SESSIONS = int(os.getenv("MAX_SESSIONS", "6"))

# Preview: the user's dev server must listen on 0.0.0.0:PREVIEW_PORT inside the sandbox.
PREVIEW_PORT = int(os.getenv("PREVIEW_PORT", "3000"))
# Wildcard domain whose subdomains all point at this server, e.g. "3.80.104.25.nip.io"
# (nip.io resolves <anything>.3.80.104.25.nip.io to 3.80.104.25) or "preview.yourdomain.com".
PREVIEW_DOMAIN = os.getenv("PREVIEW_DOMAIN", "")
# Simpler alternative for single-host demos: a public tunnel (localhost.run, ngrok...) pointed straight at
# PREVIEW_PORT. Put its URL in PREVIEW_URL, or in the file named by PREVIEW_URL_FILE (read on every request,
# so a restarted tunnel with a new URL needs no API restart).
PREVIEW_URL = os.getenv("PREVIEW_URL", "")
PREVIEW_URL_FILE = os.getenv("PREVIEW_URL_FILE", "")
# Scheme of preview links. "https" behind an ALB/Caddy with a wildcard certificate (links then
# carry no port); "http" keeps the dev behaviour (http://<token>.<domain>:<api port>/).
PREVIEW_SCHEME = os.getenv("PREVIEW_SCHEME", "http")
PREVIEW_TTL = int(os.getenv("PREVIEW_TTL", str(60 * 60 * 24)))

# Where Strands stores conversation history. Use a shared disk (or S3SessionManager)
# if you run workers on more than one machine.
SESSIONS_DIR = os.getenv("SESSIONS_DIR", "./sessions")
# Set to keep chat history in S3 instead (needed when workers run on more than one machine).
SESSIONS_S3_BUCKET = os.getenv("SESSIONS_S3_BUCKET", "")
SESSIONS_S3_PREFIX = os.getenv("SESSIONS_S3_PREFIX", "sessions/")
AWS_REGION = os.getenv("AWS_REGION", "") or os.getenv("AWS_DEFAULT_REGION", "") or None

# Worker shutdown: on SIGTERM stop taking jobs, let running jobs finish for up to this many seconds,
# then re-queue the unfinished ones (the next worker resumes from the workspace + plan files).
WORKER_SHUTDOWN_GRACE = int(os.getenv("WORKER_SHUTDOWN_GRACE", "120"))
MAX_JOB_ATTEMPTS = int(os.getenv("MAX_JOB_ATTEMPTS", "3"))
# The worker writes a heartbeat key so /ready (and ops) can see it is alive.
WORKER_HEARTBEAT_TTL = int(os.getenv("WORKER_HEARTBEAT_TTL", "30"))

JOBS_QUEUE = "jobs"


def stream_key(run_id: str) -> str:
    return f"run:{run_id}"


def owner_key(run_id: str) -> str:
    return f"run:{run_id}:owner"


def lock_key(sandbox_id: str) -> str:
    """One active run per project: prevents two agents editing the same workspace."""
    return f"lock:{sandbox_id}"


def preview_key(token: str) -> str:
    return f"preview:{token}"

# Durable copy of each project's source, restored if the Docker volume is lost ("" disables).
SNAPSHOT_DIR = os.getenv("SNAPSHOT_DIR", "")
SNAPSHOT_EVERY = int(os.getenv("SNAPSHOT_EVERY", "15"))  # tool calls between snapshots
# Copy snapshots to S3 as well (uploaded after each local tar; restored from S3 when the local
# file is missing, e.g. on a new worker host). Empty disables. Uses the default AWS credential chain.
SNAPSHOT_S3_BUCKET = os.getenv("SNAPSHOT_S3_BUCKET", "")
SNAPSHOT_S3_PREFIX = os.getenv("SNAPSHOT_S3_PREFIX", "snapshots/")


def sandbox_addr_key(sandbox_id: str) -> str:
    """host:port where the sandbox's PREVIEW_PORT is reachable (bridge mode), set by the worker."""
    return f"sandbox:{sandbox_id}:addr"


def worker_heartbeat_key(worker_id: str) -> str:
    return f"worker:{worker_id}:heartbeat"
