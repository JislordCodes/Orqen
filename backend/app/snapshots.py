"""Durable project snapshots: <SNAPSHOT_DIR>/<sandbox_id>.tar.gz on local disk and, when
SNAPSHOT_S3_BUCKET is set, a copy at s3://<bucket>/<SNAPSHOT_S3_PREFIX><sandbox_id>.tar.gz.

The worker writes them (sandbox.py). The API only reads the list of a user's projects, so it can
run on a machine without the snapshot disk (Fargate) when S3 is configured."""
import logging
import os
import re
import tarfile
import time

from . import config

log = logging.getLogger("snapshots")
_s3 = None


def s3_enabled() -> bool:
    return bool(config.SNAPSHOT_S3_BUCKET)


def _client():
    global _s3
    if _s3 is None:
        import boto3  # imported lazily: dev installs that never use S3 still work without AWS config

        _s3 = boto3.client("s3", region_name=config.AWS_REGION)
    return _s3


def s3_key(name: str) -> str:
    return f"{config.SNAPSHOT_S3_PREFIX}{name}"


def title_of(path: str) -> str:
    """The product name from .orqen/spec.md in a snapshot ("# Snake — Product Spec" -> "Snake")."""
    try:
        with tarfile.open(path) as tf:
            f = tf.extractfile("./.orqen/spec.md")
            first = f.read(400).decode(errors="ignore").splitlines()[0] if f else ""
    except Exception:  # noqa: BLE001
        return ""
    t = first.lstrip("# ").strip()
    return re.split(r"\s+[—–-]\s+(Product )?Spec", t)[0].strip()[:60]


def upload(sandbox_id: str, path: str, name: str | None = None) -> bool:
    """Copy a local snapshot to S3. Never raises (a failed upload must not break a run)."""
    if not s3_enabled():
        return False
    try:
        title = title_of(path).encode("ascii", "ignore").decode()[:60]
        _client().upload_file(
            path, config.SNAPSHOT_S3_BUCKET, s3_key(name or f"{sandbox_id}.tar.gz"),
            ExtraArgs={"ContentType": "application/gzip", "Metadata": {"title": title, "sandbox": sandbox_id}},
        )
        return True
    except Exception:  # noqa: BLE001
        log.exception("S3 upload of snapshot %s failed", sandbox_id)
        return False


def download(sandbox_id: str, path: str) -> bool:
    """Fetch the S3 copy to `path` when it exists. Returns True when a file was written."""
    if not s3_enabled():
        return False
    try:
        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)
        tmp = path + ".dl"
        _client().download_file(config.SNAPSHOT_S3_BUCKET, s3_key(f"{sandbox_id}.tar.gz"), tmp)
        os.replace(tmp, path)
        log.info("restored snapshot %s from S3", sandbox_id)
        return True
    except Exception as e:  # noqa: BLE001 - 404 is the normal "no snapshot yet" case
        if "404" not in str(e) and "Not Found" not in str(e):
            log.warning("S3 download of snapshot %s failed: %s", sandbox_id, e)
        return False


def list_projects(uid: str) -> dict[str, tuple[float, str]]:
    """{project_id: (mtime, title)} for the user's snapshots (local dir and S3 combined)."""
    out: dict[str, tuple[float, str]] = {}
    prefix = f"{uid}-"
    if config.SNAPSHOT_DIR and os.path.isdir(config.SNAPSHOT_DIR):
        for f in os.listdir(config.SNAPSHOT_DIR):
            if f.startswith(prefix) and f.endswith(".tar.gz"):
                p = os.path.join(config.SNAPSHOT_DIR, f)
                out[f[len(prefix):-len(".tar.gz")]] = (os.path.getmtime(p), title_of(p))
    if s3_enabled():
        try:
            pages = _client().get_paginator("list_objects_v2").paginate(
                Bucket=config.SNAPSHOT_S3_BUCKET, Prefix=s3_key(prefix))
            for page in pages:
                for obj in page.get("Contents", []):
                    name = obj["Key"].rsplit("/", 1)[-1]
                    if not name.endswith(".tar.gz") or "/archive/" in obj["Key"]:
                        continue
                    pid = name[len(prefix):-len(".tar.gz")]
                    ts = obj["LastModified"].timestamp()
                    if pid in out and out[pid][0] >= ts and out[pid][1]:
                        continue
                    title = ""
                    try:
                        head = _client().head_object(Bucket=config.SNAPSHOT_S3_BUCKET, Key=obj["Key"])
                        title = head.get("Metadata", {}).get("title", "")
                    except Exception:  # noqa: BLE001
                        pass
                    out[pid] = (max(ts, out.get(pid, (0, ""))[0]), title or out.get(pid, (0, ""))[1])
        except Exception:  # noqa: BLE001
            log.exception("listing S3 snapshots for %s failed", uid)
    return out


def archive_name(sandbox_id: str, slug: str) -> str:
    return f"archive/{sandbox_id}.{time.strftime('%Y%m%d-%H%M%S')}{'.' + slug if slug else ''}.tar.gz"
