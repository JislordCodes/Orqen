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
from docker.errors import APIError, ImageNotFound, NotFound

from . import config, snapshots

_dc_client = None
_create_lock = threading.Lock()


def _docker():
    """Docker client, created on first use (importing this module must not need a daemon)."""
    global _dc_client
    if _dc_client is None:
        _dc_client = docker.from_env()
    return _dc_client


def docker_ok() -> bool:
    try:
        return bool(_docker().ping())
    except Exception:  # noqa: BLE001
        return False

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
                ["sh", "-c", f"tar czf - --ignore-failed-read --warning=no-file-changed {ex} -C {WORKSPACE} ."], demux=True)
            # tar exits 1 when a file changed while it was read (a dev server, an SQLite db); the
            # archive is still complete, so only exit 2+ is a failure.
            if code not in (0, 1) or not out:
                log.warning("snapshot of %s failed: %s", user_id, (err or b"")[:300])
                return False
            os.makedirs(os.path.dirname(path), exist_ok=True)
            tmp = path + ".tmp"
            with open(tmp, "wb") as f:
                f.write(out)
            os.replace(tmp, path)
            snapshots.upload(user_id, path)
            return True
        except Exception:  # noqa: BLE001 - a snapshot must never break a run
            log.exception("snapshot of %s failed", user_id)
            return False


def archive(user_id: str, label: str = "") -> str | None:
    """Keep a dated copy of the project before something may replace it (e.g. a new plan)."""
    path = _snapshot_path(user_id)
    if not path or not snapshot(user_id):
        return None
    slug = "".join(ch if ch.isalnum() else "-" for ch in label.lower())[:40].strip("-")
    dest = os.path.join(os.path.dirname(path), "archive",
                        f"{user_id}.{time.strftime('%Y%m%d-%H%M%S')}{'.' + slug if slug else ''}.tar.gz")
    os.makedirs(os.path.dirname(dest), exist_ok=True)
    with open(path, "rb") as src, open(dest, "wb") as out:
        out.write(src.read())
    snapshots.upload(user_id, dest, name="archive/" + os.path.basename(dest))
    return dest


def _restore(user_id: str, container) -> None:
    path = _snapshot_path(user_id)
    if not path:
        return
    _, out = container.exec_run(["sh", "-c", f"ls -A {WORKSPACE}"])
    if out and out.strip():
        return  # the volume survived; nothing to restore
    # A new worker host has no local copy: fetch the S3 one when snapshots go to S3.
    if not os.path.exists(path) and not snapshots.download(user_id, path):
        return
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


def _host_network() -> bool:
    return config.SANDBOX_NETWORK == "host"


def preview_addr(user_id: str, container=None) -> tuple[str, int] | None:
    """(host, port) where the sandbox's PREVIEW_PORT can be reached from this worker host and, via
    SANDBOX_ADVERTISE_HOST, from the API. Host networking: the port itself on this host. Otherwise the
    random host port Docker published for it."""
    if _host_network():
        return config.SANDBOX_ADVERTISE_HOST, config.PREVIEW_PORT
    try:
        c = container or _docker().containers.get(f"sbx-{user_id}")
        c.reload()
        binding = (c.attrs["NetworkSettings"]["Ports"] or {}).get(f"{config.PREVIEW_PORT}/tcp") or []
        if binding:
            return config.SANDBOX_ADVERTISE_HOST, int(binding[0]["HostPort"])
    except Exception:  # noqa: BLE001
        log.exception("could not read the published preview port of %s", user_id)
    return None


def register_addr(user_id: str, container=None) -> None:
    """Record where the sandbox's preview is reachable, so the API (on any host) can proxy to it."""
    addr = preview_addr(user_id, container)
    if not addr:
        return
    try:
        from .events import get_redis

        get_redis().set(config.sandbox_addr_key(user_id), f"{addr[0]}:{addr[1]}")
    except Exception:  # noqa: BLE001 - previews degrade, runs keep going
        log.exception("could not register the preview address of %s", user_id)


def _wrong_network(c) -> bool:
    """A container made under a different SANDBOX_NETWORK (e.g. host before a switch to bridge)."""
    mode = c.attrs.get("HostConfig", {}).get("NetworkMode", "")
    want = config.SANDBOX_NETWORK
    if want == "host":
        return mode != "host"
    return mode == "host" or (want != "bridge" and mode not in (want, "default"))


def _run_kwargs(user_id: str) -> dict:
    kw: dict = dict(
        name=f"sbx-{user_id}",
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
    if not _host_network():
        # Own network namespace per sandbox; the preview port gets a random free host port.
        kw["ports"] = {f"{config.PREVIEW_PORT}/tcp": (config.SANDBOX_PUBLISH_IP, None)}
        kw["security_opt"] = ["no-new-privileges"]
        kw["cap_drop"] = ["NET_RAW", "MKNOD", "AUDIT_WRITE"]
    if config.SANDBOX_RUNTIME:
        kw["runtime"] = config.SANDBOX_RUNTIME
    return kw


_networks_ready: set[str] = set()


def _ensure_network(dc) -> None:
    """A user-defined SANDBOX_NETWORK (e.g. "orqen-sbx", which the EC2 host firewalls off from the
    VPC and the metadata service) is created on first use if the host has not created it already."""
    net = config.SANDBOX_NETWORK
    if net in ("host", "bridge", "none") or net in _networks_ready:
        return
    try:
        dc.networks.get(net)
    except NotFound:
        try:
            dc.networks.create(net, driver="bridge", labels={"appbuilder": "sandbox-network"})
        except APIError:
            pass  # created concurrently
    _networks_ready.add(net)


def get_container(user_id: str):
    name = f"sbx-{user_id}"
    dc = _docker()
    _ensure_network(dc)
    with _create_lock:
        try:
            c = dc.containers.get(name)
            if _wrong_network(c):
                # Recreate on the configured network. The workspace lives in the volume, so nothing is lost.
                log.info("recreating %s on network %s", name, config.SANDBOX_NETWORK)
                c.remove(force=True)
                raise NotFound(name)
            if c.status != "running":
                c.start()
                register_addr(user_id, c)  # a restart may publish a different host port
            return c
        except NotFound:
            pass
        try:
            c = dc.containers.run(config.SANDBOX_IMAGE, **_run_kwargs(user_id))
            register_addr(user_id, c)
            try:
                _restore(user_id, c)
            except Exception:  # noqa: BLE001
                log.exception("restore of %s failed", user_id)
            return c
        except ImageNotFound:
            raise RuntimeError(f"sandbox image {config.SANDBOX_IMAGE!r} is not available on this worker host "
                               "(build it or check SANDBOX_IMAGE / the registry login)") from None
        except APIError:
            # Another process created it between our get() and run().
            return dc.containers.get(name)


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
