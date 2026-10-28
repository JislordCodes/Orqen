"""Pluggable authentication for the API.

AUTH_MODE=dev (default): trust the user id the client sends in X-User-Id (or ?user_id= for
    EventSource, which cannot set headers). Development only.
AUTH_MODE=jwt: require "Authorization: Bearer <token>" (or ?access_token=<token> on the SSE route,
    again because EventSource cannot set headers). The token's signature is checked against the keys
    published at JWT_JWKS_URL, plus exp/nbf, and iss/aud when JWT_ISSUER / JWT_AUDIENCE are set.
    The user id is the JWT_USER_CLAIM claim (default "sub"). Works with Auth0, Clerk, Cognito,
    Supabase, Firebase (any provider that publishes a JWKS).

The user id names Docker containers, volumes, Redis keys and snapshot files, so it must be a short
safe string. Ids that are not (e.g. Auth0's "google-oauth2|1234...") are mapped to a stable hash.
"""
import hashlib
import re

import jwt
from fastapi import Header, HTTPException, Query

from . import config

_SAFE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,39}$")
_jwks: "jwt.PyJWKClient | None" = None


def safe_user_id(raw: str) -> str:
    """Lowercase, container-safe and at most 40 chars. Stable for the same input."""
    if _SAFE.match(raw) and raw == raw.lower():
        return raw
    return "u" + hashlib.sha256(raw.encode()).hexdigest()[:24]


def _jwks_client() -> "jwt.PyJWKClient":
    global _jwks
    if _jwks is None:
        if not config.JWT_JWKS_URL:
            raise HTTPException(500, "AUTH_MODE=jwt but JWT_JWKS_URL is not set")
        _jwks = jwt.PyJWKClient(config.JWT_JWKS_URL, cache_keys=True, lifespan=3600)
    return _jwks


def verify_token(token: str) -> str:
    """Returns the safe user id for a valid token, raises HTTP 401 otherwise."""
    try:
        key = _jwks_client().get_signing_key_from_jwt(token)
        claims = jwt.decode(
            token,
            key.key,
            algorithms=config.JWT_ALGORITHMS,
            audience=config.JWT_AUDIENCE or None,
            issuer=config.JWT_ISSUER or None,
            options={"verify_aud": bool(config.JWT_AUDIENCE), "require": ["exp"]},
            leeway=30,
        )
    except HTTPException:
        raise
    except jwt.PyJWTError as e:
        raise HTTPException(401, f"invalid token: {e}") from None
    sub = str(claims.get(config.JWT_USER_CLAIM) or "")
    if not sub:
        raise HTTPException(401, f"token has no '{config.JWT_USER_CLAIM}' claim")
    return safe_user_id(sub)


def _dev_user(uid: str) -> str:
    if not uid or not uid.replace("-", "").replace("_", "").isalnum() or len(uid) > 40:
        raise HTTPException(401, "missing or invalid user id")
    return uid


async def current_user(
    authorization: str = Header(default=""),
    x_user_id: str = Header(default=""),
    user_id: str = Query(default=""),
    access_token: str = Query(default=""),
) -> str:
    """FastAPI dependency: the authenticated user's id."""
    if config.AUTH_MODE == "jwt":
        token = ""
        if authorization.lower().startswith("bearer "):
            token = authorization[7:].strip()
        token = token or access_token
        if not token:
            raise HTTPException(401, "missing bearer token", headers={"WWW-Authenticate": "Bearer"})
        return verify_token(token)
    if config.AUTH_MODE != "dev":
        raise HTTPException(500, f"unknown AUTH_MODE {config.AUTH_MODE!r}")
    return _dev_user(x_user_id or user_id)
