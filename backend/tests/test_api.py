import fakeredis.aioredis
import pytest
from fastapi.testclient import TestClient

from app import api, config


@pytest.fixture()
def client(monkeypatch):
    fake = fakeredis.aioredis.FakeRedis(decode_responses=True)
    monkeypatch.setattr(api, "r", fake)
    monkeypatch.setattr(config, "SNAPSHOT_DIR", "")
    monkeypatch.setattr(config, "SNAPSHOT_S3_BUCKET", "")
    return TestClient(api.app), fake


def test_live_health_ready(client):
    c, _ = client
    assert c.get("/live").json() == {"ok": True}
    assert c.get("/health").json() == {"ok": True}
    body = c.get("/ready").json()
    assert body["ok"] is True and body["redis"] == "ok" and body["workers"] == 0


def test_dev_auth_required(client):
    c, _ = client
    assert c.post("/runs", json={"prompt": "hi"}).status_code == 401
    assert c.post("/runs", json={"prompt": "hi"}, headers={"X-User-Id": "bad id!"}).status_code == 401


def test_create_run_queues_job_and_locks(client):
    c, fake = client
    h = {"X-User-Id": "demo-user"}
    res = c.post("/runs", json={"prompt": "build a todo app", "project_id": "todo"}, headers=h)
    assert res.status_code == 200
    assert c.post("/runs", json={"prompt": "again", "project_id": "todo"}, headers=h).status_code == 409
    projects = c.get("/projects", headers=h).json()["projects"]
    assert projects[0]["id"] == "todo" and projects[0]["active_run_id"] == res.json()["run_id"]


def test_cors_allow_list(client):
    c, _ = client
    ok = c.options("/runs", headers={"Origin": "https://app.example.com", "Access-Control-Request-Method": "POST"})
    assert ok.headers.get("access-control-allow-origin") == "https://app.example.com"
    bad = c.options("/runs", headers={"Origin": "https://evil.example", "Access-Control-Request-Method": "POST"})
    assert "access-control-allow-origin" not in bad.headers


def test_caddy_ask(client, monkeypatch):
    c, fake = client
    monkeypatch.setattr(config, "PREVIEW_DOMAIN", "preview.example.com")
    import asyncio

    asyncio.get_event_loop_policy().new_event_loop().run_until_complete(
        fake.set(config.preview_key("0123456789abcdef"), "demo-user-main"))
    assert c.get("/_caddy/ask", params={"domain": "0123456789abcdef.preview.example.com"}).status_code == 200
    assert c.get("/_caddy/ask", params={"domain": "ffffffffffffffff.preview.example.com"}).status_code == 404
    assert c.get("/_caddy/ask", params={"domain": "evil.com"}).status_code == 404


def test_preview_https_link(client, monkeypatch):
    c, _ = client
    monkeypatch.setattr(config, "PREVIEW_DOMAIN", "preview.example.com")
    monkeypatch.setattr(config, "PREVIEW_SCHEME", "https")
    res = c.post("/preview", json={"project_id": "main"}, headers={"X-User-Id": "demo-user"})
    assert res.status_code == 200
    assert res.json()["url"].startswith("https://") and res.json()["url"].endswith(".preview.example.com/")
