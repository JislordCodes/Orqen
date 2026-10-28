from app import config, sandbox


def test_bridge_publishes_preview_port(monkeypatch):
    monkeypatch.setattr(config, "SANDBOX_NETWORK", "orqen-sbx")
    monkeypatch.setattr(config, "SANDBOX_PUBLISH_IP", "0.0.0.0")
    kw = sandbox._run_kwargs("demo-user-main")
    assert kw["network_mode"] == "orqen-sbx"
    assert kw["ports"] == {f"{config.PREVIEW_PORT}/tcp": ("0.0.0.0", None)}
    assert "no-new-privileges" in kw["security_opt"]


def test_host_network_keeps_dev_behaviour(monkeypatch):
    monkeypatch.setattr(config, "SANDBOX_NETWORK", "host")
    monkeypatch.setattr(config, "SANDBOX_ADVERTISE_HOST", "127.0.0.1")
    kw = sandbox._run_kwargs("demo-user-main")
    assert "ports" not in kw and kw["network_mode"] == "host"
    assert sandbox.preview_addr("demo-user-main") == ("127.0.0.1", config.PREVIEW_PORT)


def test_runtime_option(monkeypatch):
    monkeypatch.setattr(config, "SANDBOX_RUNTIME", "runsc")
    assert sandbox._run_kwargs("x")["runtime"] == "runsc"


class _C:
    def __init__(self, mode):
        self.attrs = {"HostConfig": {"NetworkMode": mode}}


def test_wrong_network_detection(monkeypatch):
    monkeypatch.setattr(config, "SANDBOX_NETWORK", "orqen-sbx")
    assert sandbox._wrong_network(_C("host"))
    assert not sandbox._wrong_network(_C("orqen-sbx"))
    monkeypatch.setattr(config, "SANDBOX_NETWORK", "host")
    assert sandbox._wrong_network(_C("bridge"))
