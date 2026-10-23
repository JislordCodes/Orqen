"""Per-user Docker sandbox.

One container + one named volume per user. The volume holds /workspace, so the
user's project persists between runs. All agent tools go through this module, so
swapping Docker for Firecracker / gVisor / E2B later means rewriting only this file.
"""
import io
import logging
import os
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
log = logging.getLogger("sandbox")

# Docker volumes can vanish (e.g. a host reset), so every project's source is also
# snapshotted to SNAPSHOT_DIR on durable storage and restored into a fresh container.
# Heavy, rebuildable dirs are left out to keep snapshots small.
SNAPSHOT_EXCLUDES = ["node_modules", ".venv", "venv", "__pycache__", ".mypy_cache", ".pytest_cache",
                     ".ruff_cache", "dist", "build", ".next", ".cache", ".turbo", "*.pyc"]
_snap_lock = threading.Lock()


def _snapshot_path(user_id: str) -> str | None:
    d = config.SNAPSHOT_DIR
    return os.path.join(d, f"{user_id}.tar.gz") if d else None


def snapshot(user_id: str) -> bool:
    """Save the project's source (not deps) to durable storage. Safe to call often."""
    path = _snapshot_path(user_id)
    if not path:
        return False
    with _snap_lock:
        try:
            ex = " ".join(f"--exclude='{e}'" for e in SNAPSHOT_EXCLUDES)
            code, (out, err) = get_container(user_id).exec_run(
                ["sh", "-c", f"tar czf - {ex} -C {WORKSPACE} ."], demux=True)
            if code != 0 or not out:
                log.warning("snapshot of %s failed: %s", user_id, (err or b"")[:300])
                return False
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(out)
            os.replace(tmp, path)
            return True
        except Exception:  # noqa: BLE001 - a snapshot must never break a run
            log.exception("snapshot of %s failed", user_id)
            return False


def _restore(user_id: str, container) -> None:
    path = _snapshot_path(user_id)
    if not path or not os.path.exists(path):
        return
    _, out = container.exec_run(["sh", "-c", f"ls -A {WORKSPACE}"])
    if out and out.strip():
        return  # the volume survived; nothing to restore
    with open(path, "rb") as f:
        data = f.read()
    container.exec_run(["mkdir", "-p", WORKSPACE])
    container.put_archive("/tmp", _wrap_tar("restore.tgz", data))
    container.exec_run(["sh", "-c", f"tar xzf /tmp/restore.tgz -C {WORKSPACE} && rm /tmp/restore.tgz"])
    container.exec_run(["sh", "-c", f"mkdir -p {WORKSPACE}/.orqen && printf '\\n- NOTE: the workspace was restored from a snapshot after the machine restarted. "
                        "Dependencies (node_modules, .venv) and running processes are gone: reinstall and restart them before run_checks.\\n' "
                        f">> {WORKSPACE}/.orqen/progress.md"])
    log.info("restored %s from snapshot (%d bytes); dependencies need reinstalling", user_id, len(data))


def _wrap_tar(name: str, data: bytes) -> bytes:
    buf = io.BytesIO()
    with tarfile.open(fileobj=buf, mode="w") as tar:
        info = tarfile.TarInfo(name=name)
        info.size = len(data)
        info.mtime = time.time()
        tar.addfile(info, io.BytesIO(data))
    return buf.getvalue()


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
            c = _dc.containers.run(
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
            try:
                _restore(user_id, c)
            except Exception:  # noqa: BLE001
                log.exception("restore of %s failed", user_id)
            return c
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
