"""Central configuration. Everything comes from environment variables (.env in dev)."""
import os

from dotenv import load_dotenv

load_dotenv()

REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

# Only the WORKER needs this key. The API server never touches the LLM.
NEBIUS_API_KEY = os.getenv("NEBIUS_API_KEY")
BASE_URL = os.getenv("BASE_URL")
MODEL_ID = os.getenv("MODEL_ID", "")
MAX_TOKENS = int(os.getenv("MAX_TOKENS", "8192"))

# Sandbox (one Docker container + one volume per user)
SANDBOX_IMAGE = os.getenv("SANDBOX_IMAGE", "appbuilder-sandbox:latest")
# "bridge" lets npm/pip install work in dev. In production use an egress proxy
# that only allows package registries, or "none" if you pre-bake dependencies.
SANDBOX_NETWORK = os.getenv("SANDBOX_NETWORK", "bridge")
SANDBOX_MEM = os.getenv("SANDBOX_MEM", "1g")
SANDBOX_CPUS = float(os.getenv("SANDBOX_CPUS", "1.0"))

# Worker limits
MAX_CONCURRENT_RUNS = int(os.getenv("MAX_CONCURRENT_RUNS", "4"))
MAX_TOOL_CALLS = int(os.getenv("MAX_TOOL_CALLS", "80"))  # hard budget per run

# Preview: the user's dev server must listen on 0.0.0.0:PREVIEW_PORT inside the sandbox.
PREVIEW_PORT = int(os.getenv("PREVIEW_PORT", "3000"))
# Wildcard domain whose subdomains all point at this server, e.g. "3.80.104.25.nip.io"
# (nip.io resolves <anything>.3.80.104.25.nip.io to 3.80.104.25) or "preview.yourdomain.com".
PREVIEW_DOMAIN = os.getenv("PREVIEW_DOMAIN", "")

# Where Strands stores conversation history. Use a shared disk (or S3SessionManager)
# if you run workers on more than one machine.
SESSIONS_DIR = os.getenv("SESSIONS_DIR", "./sessions")

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
