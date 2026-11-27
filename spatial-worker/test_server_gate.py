"""The server's wiring of the token check and the provider-side face refusal. Needs the worker image (torch, FastAPI)."""
import base64
import hashlib
import hmac
import importlib.util
import json
import pathlib
import tempfile
import time
import unittest

HAVE_SERVER = all(importlib.util.find_spec(name) for name in ("torch", "fastapi"))
JOB = "11111111-1111-4111-8111-111111111111"
TYPE = "spatial.reconstruct"
SECRET = b"k" * 32


def token(secret=SECRET, **overrides):
    now = int(time.time())
    claims = {"v": 2, "jobId": JOB, "type": TYPE, "purpose": "process", "iat": now, "exp": now + 90, "nonce": "nonce-" + str(time.monotonic_ns()),
              "capture": "/var/lib/kubus-node/a", "output": "/var/lib/kubus-node/b", "mode": "prepared", "mask": ""}
    claims.update(overrides)
    raw = base64.urlsafe_b64encode(json.dumps(claims).encode()).decode().rstrip("=")
    mac = base64.urlsafe_b64encode(hmac.new(secret, raw.encode(), hashlib.sha256).digest()).decode().rstrip("=")
    return f"{raw}.{mac}"


@unittest.skipUnless(HAVE_SERVER, "needs torch and FastAPI (the worker image)")
class ServerGateTests(unittest.TestCase):
    def setUp(self):
        import server
        from fastapi import HTTPException

        self.server, self.http = server, HTTPException
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        key = pathlib.Path(self.temp.name) / "worker-auth.key"
        key.write_bytes(SECRET)
        previous = server.WORKER_AUTH_KEY_PATH
        server.WORKER_AUTH_KEY_PATH = str(key)
        self.addCleanup(setattr, server, "WORKER_AUTH_KEY_PATH", previous)
        server.TOKEN_NONCES.seen.clear()
        self.request = server.ProcessRequest(jobId=JOB, type=TYPE, workerInstanceId="w", captureDirectory="/var/lib/kubus-node/a",
                                             outputDirectory="/var/lib/kubus-node/b", input={"mode": "prepared"})

    def test_a_bound_token_works_once_and_not_for_other_paths_or_the_other_endpoint(self):
        self.server.authorize_worker(token(), self.request, "process")
        replay = token(nonce="nonce-fixed-1")
        self.server.authorize_worker(replay, self.request, "process")
        with self.assertRaises(self.http) as raised:
            self.server.authorize_worker(replay, self.request, "process")
        self.assertEqual(raised.exception.status_code, 401)
        other = self.request.model_copy(update={"outputDirectory": "/var/lib/kubus-node/elsewhere"})
        with self.assertRaises(self.http):
            self.server.authorize_worker(token(), other, "process")
        with self.assertRaises(self.http):
            self.server.authorize_worker(token(), self.request, "cancel")

    def test_a_missing_token_is_authorization_required(self):
        with self.assertRaises(self.http) as raised:
            self.server.authorize_worker(None, self.request, "process")
        self.assertEqual(raised.exception.detail, "worker_authorization_required")

    def test_a_prepared_record_with_flagged_images_is_refused_before_training(self):
        import video_pipeline as vp

        look = lambda **fields: {"needsLook": {"images": 0, "weakExcluded": 0, "largeBelowCertain": 0, "items": [], **fields}}
        self.server.require_no_face_review({"faceMasking": {"photos": look()}})
        for record in ({"faceMasking": {"photos": look(images=1, largeBelowCertain=1, items=[{"image": 7}])}}, {}, {"faceMasking": None}):
            with self.subTest(record=record):
                with self.assertRaises(vp.WorkerError) as raised:
                    self.server.require_no_face_review(record)
                self.assertEqual(raised.exception.code, "provider_face_review_required")

    # The Node's cleanup depends on this exact stale-instance contract (src/jobs/jobCleanup.ts): a cancel naming an
    # instance that is not this process is refused with 409 worker_instance_changed, /health reports the current
    # instance id with cleanupProtocol 1, and a cancel naming the current instance returns a receipt that carries it.
    def cancel_request(self, instance):
        return self.server.JobRequest(jobId=JOB, type=TYPE, workerInstanceId=instance)

    def test_a_cancel_for_another_instance_is_refused_409_worker_instance_changed(self):
        import asyncio

        stale = self.cancel_request("an-instance-that-has-gone")
        with self.assertRaises(self.http) as raised:
            asyncio.run(self.server.cancel(stale, token(purpose="cancel")))
        self.assertEqual(raised.exception.status_code, 409)
        self.assertEqual(raised.exception.detail, "worker_instance_changed")

    def test_a_cancel_for_this_instance_returns_a_quiescent_receipt_carrying_the_instance_id(self):
        import asyncio
        from job_control import JobControl

        previous = self.server.control
        self.server.control = JobControl(str(pathlib.Path(self.temp.name) / "control"))
        self.addCleanup(setattr, self.server, "control", previous)
        receipt = asyncio.run(self.server.cancel(self.cancel_request(self.server.WORKER_INSTANCE_ID), token(purpose="cancel")))
        self.assertEqual(receipt, {"jobId": JOB, "quiescent": True, "cleanupProtocol": 1, "workerInstanceId": self.server.WORKER_INSTANCE_ID})

    def fake_control(self, events, unreaped=()):
        class Fake:
            pass

        fake = Fake()
        fake.unreaped = list(unreaped)
        fake.reap_orphans = lambda: events.append("reap")
        fake.finish_pending_hand_backs = lambda: events.append("finish")
        fake.pend_hand_back = lambda job, directory: events.append(("pend", job, directory))
        fake.settle_hand_back = lambda job, directory: events.append(("settle", job, directory))
        return fake

    def test_start_up_recovery_reaps_orphans_before_it_hands_trees_back(self):
        events = []
        self.assertIs(self.server.recover_after_restart(self.fake_control(events)), True)
        self.assertEqual(events, ["reap", "finish"])
        self.assertIs(self.server.recover_after_restart(self.fake_control([], unreaped=["x.owner"])), False)

    def test_the_module_runs_start_up_recovery_on_its_own_control_before_serving(self):
        source = pathlib.Path(self.server.__file__).read_text(encoding="utf-8")
        self.assertIn("REAPS_ORPHANS = recover_after_restart(control)", source)

    def test_a_job_is_recorded_for_hand_back_before_it_runs_and_settled_after_whatever_its_outcome(self):
        for outcome in ("returns", "raises"):
            events = []
            previous = (self.server.control, self.server.run_reconstruction)
            self.server.control = self.fake_control(events)

            def run(request, events=events, outcome=outcome):
                events.append("run")
                if outcome == "raises":
                    raise RuntimeError("worker failed")
                return {"ok": True}

            self.server.run_reconstruction = run
            try:
                if outcome == "raises":
                    with self.assertRaises(RuntimeError):
                        self.server.process_owned(self.request)
                else:
                    self.server.process_owned(self.request)
            finally:
                self.server.control, self.server.run_reconstruction = previous
            directory = self.request.outputDirectory
            self.assertEqual(events, [("pend", JOB, directory), "run", ("settle", JOB, directory)], outcome)

    def test_health_reports_the_cleanup_protocol_and_the_current_instance_id(self):
        previous = self.server.gpu_info
        self.server.gpu_info = lambda: {"available": False}
        self.addCleanup(setattr, self.server, "gpu_info", previous)
        health = self.server.health()
        self.assertEqual(health["cleanupProtocol"], 1)
        self.assertEqual(health["workerInstanceId"], self.server.WORKER_INSTANCE_ID)
        self.assertRegex(health["workerInstanceId"], r"^[0-9a-f-]{36}$")
        # The Node infers "the replaced worker's processes are gone" only from a worker that promises this.
        self.assertIs(health["reapsOrphans"], True)

    def test_health_withholds_the_orphan_promise_when_an_earlier_group_could_not_be_ended(self):
        previous = (self.server.gpu_info, self.server.REAPS_ORPHANS)
        self.server.gpu_info = lambda: {"available": False}
        self.server.REAPS_ORPHANS = False
        self.addCleanup(lambda: (setattr(self.server, "gpu_info", previous[0]), setattr(self.server, "REAPS_ORPHANS", previous[1])))
        self.assertIs(self.server.health()["reapsOrphans"], False)


if __name__ == "__main__":
    unittest.main()
