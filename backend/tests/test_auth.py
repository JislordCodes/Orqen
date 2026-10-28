import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException

from app import auth, config


class _Key:
    def __init__(self, key):
        self.key = key


class _FakeJwks:
    def __init__(self, public_key):
        self.public_key = public_key

    def get_signing_key_from_jwt(self, _token):
        return _Key(self.public_key)


@pytest.fixture()
def keys(monkeypatch):
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    monkeypatch.setattr(auth, "_jwks", _FakeJwks(private.public_key()))
    monkeypatch.setattr(config, "AUTH_MODE", "jwt")
    monkeypatch.setattr(config, "JWT_ISSUER", "https://issuer.example/")
    monkeypatch.setattr(config, "JWT_AUDIENCE", "orqen-api")
    return private


def _token(private, **claims):
    base = {"sub": "user_123", "iss": "https://issuer.example/", "aud": "orqen-api", "exp": int(time.time()) + 300}
    base.update(claims)
    return jwt.encode(base, private, algorithm="RS256")


def test_safe_user_id():
    assert auth.safe_user_id("demo-user") == "demo-user"
    hashed = auth.safe_user_id("google-oauth2|1234567890")
    assert hashed.startswith("u") and len(hashed) == 25 and hashed == auth.safe_user_id("google-oauth2|1234567890")
    assert auth.safe_user_id("User_ABC") != "User_ABC"  # container names are kept lowercase


@pytest.mark.anyio
async def test_jwt_valid(keys):
    uid = await auth.current_user(authorization=f"Bearer {_token(keys)}", x_user_id="", user_id="", access_token="")
    assert uid == "user_123"


@pytest.mark.anyio
async def test_jwt_query_token_for_eventsource(keys):
    uid = await auth.current_user(authorization="", x_user_id="", user_id="", access_token=_token(keys))
    assert uid == "user_123"


@pytest.mark.anyio
@pytest.mark.parametrize("claims", [{"aud": "other"}, {"iss": "https://evil/"}, {"exp": int(time.time()) - 600}])
async def test_jwt_rejected(keys, claims):
    with pytest.raises(HTTPException) as e:
        await auth.current_user(authorization=f"Bearer {_token(keys, **claims)}", x_user_id="", user_id="", access_token="")
    assert e.value.status_code == 401


@pytest.mark.anyio
async def test_jwt_mode_ignores_dev_header(keys):
    with pytest.raises(HTTPException):
        await auth.current_user(authorization="", x_user_id="demo-user", user_id="", access_token="")


@pytest.fixture()
def anyio_backend():
    return "asyncio"
