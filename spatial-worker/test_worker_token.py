import base64
import hashlib
import hmac
import json
import unittest

import worker_token as wt

SECRET = b"s" * 32
JOB = "11111111-1111-4111-8111-111111111111"
TYPE = "spatial.reconstruct"
NOW = 1_000_000


def sign(claims, secret=SECRET):
    raw = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    mac = base64.urlsafe_b64encode(hmac.new(secret, raw.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return f"{raw}.{mac}"


def claims(**overrides):
    base = {"v": 2, "jobId": JOB, "type": TYPE, "purpose": "process", "iat": NOW, "exp": NOW + 90, "nonce": "abcdefghijkl",
            "capture": "/var/lib/kubus-node/private/reconstructions/x/set", "output": "/var/lib/kubus-node/private/reconstructions/x/prepare-1",
            "mode": "source_set", "mask": "pv"}
    base.update(overrides)
    return base


def verify(token, seen=None, purpose="process", **overrides):
    wanted = dict(job_id=JOB, type_=TYPE, purpose=purpose, capture_directory="/var/lib/kubus-node/private/reconstructions/x/set",
                  output_directory="/var/lib/kubus-node/private/reconstructions/x/prepare-1", mode="source_set", mask="pv", now=NOW)
    wanted.update(overrides)
    return wt.verify_token(token, SECRET, seen=seen if seen is not None else wt.NonceCache(), **wanted)


def reason(token, **kwargs):
    with unittest.TestCase().assertRaises(wt.TokenError) as raised:
        verify(token, **kwargs)
    return raised.exception.reason


class VerifyTests(unittest.TestCase):
    def test_a_token_bound_to_the_request_is_accepted(self):
        self.assertEqual(verify(sign(claims()))["jobId"], JOB)

    def test_a_forged_expired_or_other_jobs_token_is_refused(self):
        self.assertEqual(reason(sign(claims(), secret=b"x" * 32)), "signature")
        self.assertEqual(reason(sign(claims(exp=NOW - 1))), "expiry")
        self.assertEqual(reason(sign(claims(jobId="22222222-2222-4222-8222-222222222222"))), "binding")
        self.assertEqual(reason(sign(claims(type="spatial.optimize"))), "binding")
        self.assertEqual(reason(None), "missing")

    def test_a_lifetime_over_the_cap_is_refused(self):
        self.assertEqual(reason(sign(claims(exp=NOW + wt.MAX_TTL_SECONDS + 1))), "expiry")
        verify(sign(claims(exp=NOW + wt.MAX_TTL_SECONDS)))

    def test_an_unversioned_or_nonceless_token_is_refused(self):
        legacy = claims()
        del legacy["v"]
        self.assertEqual(reason(sign(legacy)), "version")
        self.assertEqual(reason(sign(claims(v=1))), "version")
        self.assertEqual(reason(sign(claims(nonce=None))), "nonce")

    def test_a_process_token_cannot_cancel_and_a_cancel_token_cannot_process(self):
        self.assertEqual(reason(sign(claims()), purpose="cancel"), "purpose")
        cancel = claims(purpose="cancel")
        for key in ("capture", "output", "mode", "mask"):
            del cancel[key]
        verify(sign(cancel), purpose="cancel")
        self.assertEqual(reason(sign(cancel)), "purpose")

    def test_the_directories_mode_and_masking_are_bound(self):
        self.assertEqual(reason(sign(claims()), capture_directory="/var/lib/kubus-node/private/reconstructions/other/set"), "binding_capture")
        self.assertEqual(reason(sign(claims()), output_directory="/var/lib/kubus-node/elsewhere"), "binding_output")
        self.assertEqual(reason(sign(claims()), mode="prepared"), "binding_mode")
        # The replay in the review: the same token, masking switched off.
        self.assertEqual(reason(sign(claims()), mask=""), "binding_mask")

    def test_a_token_replayed_within_its_lifetime_is_refused_once_used(self):
        seen = wt.NonceCache()
        token = sign(claims())
        verify(token, seen=seen)
        self.assertEqual(reason(token, seen=seen), "replay")

    def test_a_refused_token_does_not_use_its_nonce(self):
        seen = wt.NonceCache()
        with self.assertRaises(wt.TokenError):
            verify(sign(claims()), seen=seen, mode="prepared")
        verify(sign(claims()), seen=seen)

    def test_expired_nonces_are_forgotten_and_a_full_cache_refuses_instead_of_forgetting(self):
        seen = wt.NonceCache(limit=2)
        verify(sign(claims(nonce="nonce-aaaaaa")), seen=seen)
        verify(sign(claims(nonce="nonce-bbbbbb")), seen=seen)
        self.assertEqual(reason(sign(claims(nonce="nonce-cccccc")), seen=seen), "nonce_cache_full")
        # Later, the first two have expired and make room.
        verify(sign(claims(nonce="nonce-cccccc", iat=NOW + 200, exp=NOW + 290)), seen=seen, now=NOW + 200)

    def test_mask_flags_and_mode_defaults(self):
        self.assertEqual(wt.mask_flags({"maskFaces": {"photos": True, "video": True}}), "pv")
        self.assertEqual(wt.mask_flags({"maskFaces": {"video": True}}), "v")
        self.assertEqual(wt.mask_flags({"maskFaces": {"photos": "yes"}}), "")
        self.assertEqual(wt.mask_flags({}), "")
        self.assertEqual(wt.request_mode({}), "frames")
        self.assertEqual(wt.request_mode({"mode": "prepared"}), "prepared")


if __name__ == "__main__":
    unittest.main()
