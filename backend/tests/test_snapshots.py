import io
import tarfile

from app import config, snapshots


def _snap(path, spec: str):
    data = spec.encode()
    with tarfile.open(path, "w:gz") as tf:
        info = tarfile.TarInfo("./.orqen/spec.md")
        info.size = len(data)
        tf.addfile(info, io.BytesIO(data))


def test_title_and_local_listing(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SNAPSHOT_DIR", str(tmp_path))
    monkeypatch.setattr(config, "SNAPSHOT_S3_BUCKET", "")
    _snap(tmp_path / "demo-user-snake.tar.gz", "# Snake — Product Spec\n\nbody")
    _snap(tmp_path / "other-user-x.tar.gz", "# X\n")
    found = snapshots.list_projects("demo-user")
    assert list(found) == ["snake"] and found["snake"][1] == "Snake"


def test_s3_disabled_is_noop(tmp_path, monkeypatch):
    monkeypatch.setattr(config, "SNAPSHOT_S3_BUCKET", "")
    assert snapshots.upload("x", str(tmp_path / "missing")) is False
    assert snapshots.download("x", str(tmp_path / "x.tar.gz")) is False
