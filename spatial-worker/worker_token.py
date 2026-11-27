"""The Node-to-worker authorization token: verification, binding and replay protection.

The Node signs each request's token (`src/spatial/workerAuth.ts`, HMAC-SHA256 over the base64url payload). Besides the
job id and type the token names what it is for:

* `purpose` is the endpoint (`process` or `cancel`), so a header captured from one cannot drive the other;
* a `process` token also carries the capture directory, the output directory, the input mode and which kinds of
  image face masking was asked for, so it cannot be replayed with other paths or with masking switched off;
* `nonce` is single use: the worker remembers every nonce it accepted until the token expires.

Nothing here imports torch or FastAPI, so it is tested without them.
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import threading
import time
from typing import Any

TOKEN_VERSION = 2
PURPOSES = ("process", "cancel")
MAX_TTL_SECONDS = 300
MAX_CLOCK_SKEW_SECONDS = 30
NONCE_CACHE_LIMIT = 8192


class TokenError(Exception):
    """The token is not acceptable for this request; `reason` is a short code for logs, never shown to the caller."""

    def __init__(self, reason: str):
        super().__init__(reason)
        self.reason = reason


class NonceCache:
    """Remembers accepted nonces until their token expires, so a captured header cannot be used twice."""

    def __init__(self, limit: int = NONCE_CACHE_LIMIT):
        self.limit = limit
        self.lock = threading.Lock()
        self.seen: dict[str, int] = {}

    def remember(self, nonce: str, expires_at: int, now: int) -> bool:
        """True the first time a nonce is seen; False for a replay. A full cache refuses instead of forgetting."""
        with self.lock:
            for key in [key for key, exp in self.seen.items() if exp < now]:
                del self.seen[key]
            if nonce in self.seen:
                return False
            if len(self.seen) >= self.limit:
                raise TokenError("nonce_cache_full")
            self.seen[nonce] = expires_at
            return True


def mask_flags(input_: Any) -> str:
    """Which image kinds the request asks to mask: `p` (photos), `v` (video), in that order; empty for none."""
    mask = input_.get("maskFaces") if isinstance(input_, dict) else None
    if not isinstance(mask, dict):
        return ""
    return ("p" if mask.get("photos") is True else "") + ("v" if mask.get("video") is True else "")


def request_mode(input_: Any) -> str:
    mode = input_.get("mode") if isinstance(input_, dict) else None
    return mode if isinstance(mode, str) and mode else "frames"


def _decode(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def verify_token(
    token: str | None,
    secret: bytes,
    *,
    job_id: str,
    type_: str,
    purpose: str,
    capture_directory: str | None = None,
    output_directory: str | None = None,
    mode: str | None = None,
    mask: str | None = None,
    seen: NonceCache,
    now: int | None = None,
) -> dict:
    """Returns the claims of an acceptable token; raises TokenError otherwise. A nonce is consumed only by a valid token."""
    if purpose not in PURPOSES:
        raise TokenError("purpose_unknown")
    if not token or "." not in token:
        raise TokenError("missing")
    now = int(time.time()) if now is None else now
    try:
        payload_raw, signature = token.split(".", 1)
        expected = base64.urlsafe_b64encode(hmac.new(secret, payload_raw.encode(), hashlib.sha256).digest()).decode().rstrip("=")
        if not hmac.compare_digest(signature, expected):
            raise TokenError("signature")
        claims = json.loads(_decode(payload_raw))
        if not isinstance(claims, dict):
            raise TokenError("shape")
        if claims.get("v") != TOKEN_VERSION:
            raise TokenError("version")
        if claims.get("jobId") != job_id or claims.get("type") != type_:
            raise TokenError("binding")
        if claims.get("purpose") != purpose:
            raise TokenError("purpose")
        exp, iat = int(claims.get("exp", 0)), int(claims.get("iat", now + 1))
        if exp < now or iat > now + MAX_CLOCK_SKEW_SECONDS or exp - iat > MAX_TTL_SECONDS:
            raise TokenError("expiry")
        nonce = claims.get("nonce")
        if not isinstance(nonce, str) or len(nonce) < 8 or len(nonce) > 64:
            raise TokenError("nonce")
        if purpose == "process":
            bound = {"capture": capture_directory, "output": output_directory, "mode": mode, "mask": mask}
            for key, wanted in bound.items():
                if wanted is None or claims.get(key) != wanted:
                    raise TokenError(f"binding_{key}")
    except (ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
        raise TokenError("malformed")
    if not seen.remember(nonce, exp, now):
        raise TokenError("replay")
    return claims
