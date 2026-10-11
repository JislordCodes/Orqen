"""Per-user Docker sandbox.

One container + one named volume per user. The volume holds /workspace, so the
user's project persists between runs. All agent tools go through this module, so
swapping Docker for Firecracker / gVisor / E2B later means rewriting only this file.
"""
import io
import posixpath
import tarfile
import threading
import time

import docker
from docker.errors import APIError, NotFound

from . import config

_dc = docker.from_env()
_create_lock = threading.Lock()

WORKSPACE = "/workspace"


def safe_path(path: str) -> str:
    """Resolve a user/agent supplied path and make sure it stays inside /workspace."""
    full = posixpath.normpath(posixpath.join(WORKSPACE, path or "."))
    if full != WORKSPACE and not full.startswith(WORKSPACE + "/"):
        raise ValueError(f"path '{path}' is outside the workspace")
    return full


def get_container(user_id: str):
    name = f"sbx-{user_id}"
    with _create_lock:
        try:
            c = _dc.containers.get(name)
            if c.status != "running":
                c.start()
            return c
        except NotFound:
            pass
        try:
            return _dc.containers.run(
                config.SANDBOX_IMAGE,
                name=name,
                command="sleep infinity",
                detach=True,
                working_dir=WORKSPACE,
                volumes={f"ws-{user_id}": {"bind": WORKSPACE, "mode": "rw"}},
                network_mode=config.SANDBOX_NETWORK,
                mem_limit=config.SANDBOX_MEM,
                nano_cpus=int(config.SANDBOX_CPUS * 1_000_000_000),
                pids_limit=256,
                labels={"appbuilder": "sandbox", "user": user_id},
            )
        except APIError:
            # Another process created it between our get() and run().
            return _dc.containers.get(name)


def exec_argv(user_id: str, argv: list[str], timeout: int = 60) -> tuple[int, str]:
    """Run a command inside the user's container. Returns (exit_code, combined_output)."""
    c = get_container(user_id)
    full = ["timeout", str(timeout)] + argv  # exit code 124 means it timed out
    code, (out, err) = c.exec_run(full, workdir=WORKSPACE, demux=True)
    text = (out or b"").decode(errors="replace") + (err or b"").decode(errors="replace")
    return code, text


def sh(user_id: str, cmd: str, timeout: int = 60) -> tuple[int, str]:
    return exec_argv(user_id, ["bash", "-lc", cmd], timeout=timeout)


def read_file(user_id: str, path: str) -> str:
    full = safe_path(path)
    code, out = exec_argv(user_id, ["cat", full], timeout=20)
    if code != 0:
        raise FileNotFoundError(f"cannot read {path}: {out.strip()}")
    return out


def write_file(user_id: str, path: str, content: str) -> None:
    full = safe_path(path)
    directory, name = posixpath.split(full)
    exec_argv(user_id, ["mkdir", "-p", directory], timeout=20)

    data = content.encode()
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        info = tarfile.TarInfo(name=name)
        info.size = len(data)
        info.mode = 0o644
        info.mtime = time.time()
        tar.addfile(info, io.BytesIO(data))
    get_container(user_id).put_archive(directory, buf.getvalue())
