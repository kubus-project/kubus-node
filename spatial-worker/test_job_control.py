import pathlib
import sys
import tempfile
import threading
import time
import unittest
import os
from job_control import JobControl, JobCancelled, hand_back_ownership

JOB = "11111111-1111-4111-8111-111111111111"


class HandBackOwnershipTests(unittest.TestCase):
    @unittest.skipUnless(hasattr(os, "geteuid") and os.geteuid() == 0, "needs root to create foreign-owned files")
    def test_root_written_files_are_given_to_the_directory_owner(self):
        with tempfile.TemporaryDirectory() as temp:
            output = pathlib.Path(temp) / "job"
            output.mkdir()
            os.chown(output, 12345, 23456)
            (output / "training" / "run").mkdir(parents=True)
            (output / "training" / "run" / "weights.ckpt").write_bytes(b"x")
            (output / "export.ply").write_bytes(b"y")
            outside = pathlib.Path(temp) / "outside.txt"
            outside.write_text("keep")
            (output / "link").symlink_to(outside)
            hand_back_ownership(output)
            for path in [output, output / "training", output / "training" / "run", output / "training" / "run" / "weights.ckpt", output / "export.ply"]:
                self.assertEqual((path.stat().st_uid, path.stat().st_gid), (12345, 23456), str(path))
            # The symlink target is never touched.
            self.assertEqual(outside.stat().st_uid, 0)

    def test_missing_directory_is_not_an_error(self):
        hand_back_ownership("/nonexistent/kubus-job")


class JobControlTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.control = JobControl(pathlib.Path(self.temp.name) / "control")

    def test_cancellation_before_request_is_durable(self):
        self.assertTrue(self.control.cancel(JOB)["quiescent"])
        restarted = JobControl(self.control.root)
        with self.assertRaises(JobCancelled):
            with restarted.job(JOB):
                self.fail("a delayed process request was accepted")

    def test_active_job_cannot_be_started_twice(self):
        with self.control.job(JOB):
            with self.assertRaises(ValueError):
                with self.control.job(JOB):
                    self.fail()

    def test_process_group_stops_before_quiescent_acknowledgement(self):
        sentinel = pathlib.Path(self.temp.name) / "worker-started"
        result = []
        def work():
            try:
                with self.control.job(JOB):
                    self.control.run(JOB, [sys.executable, "-c",
                        "import pathlib,time;pathlib.Path(" + repr(str(sentinel)) + ").touch();time.sleep(60)"], timeout=65)
            except JobCancelled:
                result.append("cancelled")
        thread = threading.Thread(target=work)
        thread.start()
        deadline = time.monotonic() + 5
        while not sentinel.exists() and time.monotonic() < deadline:
            time.sleep(.01)
        self.assertTrue(sentinel.exists())
        receipt = self.control.cancel(JOB)
        thread.join(timeout=2)
        self.assertFalse(thread.is_alive())
        self.assertEqual(result, ["cancelled"])
        self.assertTrue(receipt["quiescent"])
        self.assertNotIn(JOB, self.control.active)

    def test_not_quiescent_does_not_acknowledge(self):
        with self.control.job(JOB):
            with self.assertRaises(TimeoutError):
                self.control.cancel(JOB, timeout=.01)
        self.assertTrue(self.control.cancel(JOB)["quiescent"])

    def test_identifier_cannot_escape_control_directory(self):
        for value in ["../escape", "", "other/job"]:
            with self.assertRaises(ValueError):
                self.control.cancel(value)

    def test_successful_job_releases_active_handle(self):
        with self.control.job(JOB):
            completed = self.control.run(JOB, [sys.executable, "-c", "print('synthetic')"], timeout=5)
            self.assertEqual(completed.returncode, 0)
        self.assertNotIn(JOB, self.control.active)

    def test_timeout_stops_process_before_releasing_handle(self):
        import subprocess
        with self.assertRaises(subprocess.TimeoutExpired):
            with self.control.job(JOB):
                self.control.run(JOB, [sys.executable, "-c", "import time;time.sleep(60)"], timeout=.05)
        self.assertNotIn(JOB, self.control.active)


@unittest.skipUnless(pathlib.Path("/proc/self/stat").exists(), "needs Linux /proc")
class OrphanReapTests(unittest.TestCase):
    """A replacement worker ends a training process group its predecessor left behind (a supervisor restarting only uvicorn)."""

    def setUp(self):
        import subprocess
        self.subprocess = subprocess
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.control = JobControl(pathlib.Path(self.temp.name) / "control")
        self.children = []
        self.addCleanup(self.kill_children)

    def kill_children(self):
        for child in self.children:
            try:
                os.killpg(child.pid, 9)
            except (ProcessLookupError, PermissionError):
                pass
            child.wait()

    def spawn(self):
        # A session leader that also starts a grandchild, as the training script does.
        child = self.subprocess.Popen([sys.executable, "-c",
            "import subprocess,sys,time;subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);time.sleep(60)"],
            start_new_session=True)
        self.children.append(child)
        time.sleep(.5)
        return child

    def members(self, group):
        from job_control import proc_fields
        return [entry for entry in os.listdir("/proc") if entry.isdigit() and (proc_fields(int(entry)) or (None, 0, False))[0] == group and proc_fields(int(entry))[2]]

    def test_a_group_left_by_a_dead_worker_is_ended_including_its_children(self):
        child = self.spawn()
        self.control.record_group(JOB, child)
        self.assertGreaterEqual(len(self.members(child.pid)), 2)
        reaped = JobControl(self.control.root).reap_orphans()
        child.wait(timeout=5)
        self.assertEqual(reaped, [child.pid])
        time.sleep(.3)
        self.assertEqual([m for m in self.members(child.pid) if m != str(child.pid)], [])
        self.assertFalse(self.control.group_file(JOB).exists())

    def test_a_record_from_another_boot_or_for_a_reused_pid_kills_nothing(self):
        import json
        child = self.spawn()
        self.control.record_group(JOB, child)
        record = json.loads(self.control.group_file(JOB).read_text())
        for change in ({"boot": "another-boot"}, {"start": record["start"] + 1000}):
            with self.subTest(change=change):
                self.control.group_file(JOB).write_text(json.dumps({**record, **change}))
                self.assertEqual(JobControl(self.control.root).reap_orphans(), [])
                self.assertIsNone(child.poll())
                self.assertFalse(self.control.group_file(JOB).exists())

    def test_a_finished_run_leaves_no_record_and_a_missing_directory_is_fine(self):
        with self.control.job(JOB):
            self.control.run(JOB, [sys.executable, "-c", "print('synthetic')"], timeout=5)
        self.assertFalse(self.control.group_file(JOB).exists())
        self.assertEqual(JobControl(pathlib.Path(self.temp.name) / "never-created").reap_orphans(), [])

    def test_a_record_whose_processes_are_already_gone_is_cleared(self):
        child = self.spawn()
        self.control.record_group(JOB, child)
        os.killpg(child.pid, 9)
        child.wait()
        time.sleep(.3)
        self.assertEqual(JobControl(self.control.root).reap_orphans(), [])
        self.assertFalse(self.control.group_file(JOB).exists())


if __name__ == "__main__":
    unittest.main()
