import json
import pathlib
import sys
import tempfile
import threading
import time
import unittest
import unittest.mock
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

    @unittest.skipUnless(hasattr(os, "geteuid") and os.geteuid() == 0, "needs root to create foreign-owned files")
    def test_a_top_directory_replaced_by_a_symlink_is_left_alone(self):
        with tempfile.TemporaryDirectory() as temp:
            target = pathlib.Path(temp) / "target"
            target.mkdir()
            os.chown(target, 12345, 23456)
            (target / "inner.txt").write_bytes(b"x")
            link = pathlib.Path(temp) / "job"
            link.symlink_to(target)
            hand_back_ownership(link)
            self.assertEqual((target / "inner.txt").stat().st_uid, 0)

    @unittest.skipUnless(hasattr(os, "geteuid") and os.geteuid() == 0, "needs root to create foreign-owned files")
    def test_a_directory_swapped_for_a_symlink_while_the_walk_is_running_cannot_redirect_the_change(self):
        with tempfile.TemporaryDirectory() as temp:
            output = pathlib.Path(temp) / "job"
            (output / "sub").mkdir(parents=True)
            (output / "sub" / "shadow").write_text("inside")
            os.chown(output, 12345, 23456)
            outside = pathlib.Path(temp) / "etc"
            outside.mkdir()
            (outside / "shadow").write_text("outside")
            real_fwalk = os.fwalk

            def swapping(*args, **kwargs):
                for entry in real_fwalk(*args, **kwargs):
                    if os.path.basename(entry[0]) == "sub" and not (output / "sub.moved").exists():
                        # The Node user renames the directory the walk just listed and plants a link in its place.
                        os.rename(output / "sub", output / "sub.moved")
                        (output / "sub").symlink_to(outside)
                    yield entry

            with unittest.mock.patch.object(os, "fwalk", swapping):
                hand_back_ownership(output)
            self.assertEqual((outside / "shadow").stat().st_uid, 0)
            self.assertEqual(outside.stat().st_uid, 0)
            # The directory that was actually listed still got handed back, through its descriptor.
            self.assertEqual((output / "sub.moved" / "shadow").stat().st_uid, 12345)

    @unittest.skipUnless(hasattr(os, "geteuid") and os.geteuid() == 0, "needs root to create foreign-owned files")
    def test_every_change_is_made_relative_to_an_open_directory_without_following_links(self):
        with tempfile.TemporaryDirectory() as temp:
            output = pathlib.Path(temp) / "job"
            (output / "a" / "b").mkdir(parents=True)
            (output / "a" / "b" / "f").write_bytes(b"x")
            os.chown(output, 12345, 23456)
            real_chown = os.chown
            calls = []

            def recording(path, uid, gid, *, dir_fd=None, follow_symlinks=True):
                calls.append((path, dir_fd, follow_symlinks))
                return real_chown(path, uid, gid, dir_fd=dir_fd, follow_symlinks=follow_symlinks)

            with unittest.mock.patch.object(os, "chown", recording):
                hand_back_ownership(output)
            entries = [call for call in calls if isinstance(call[0], str)]
            self.assertEqual(sorted(call[0] for call in entries), ["a", "b", "f"])
            for path, dir_fd, follow_symlinks in entries:
                self.assertIsNotNone(dir_fd, path)
                self.assertIs(follow_symlinks, False, path)

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


    def test_the_launcher_records_the_group_before_the_command_runs_without_any_help_from_the_parent(self):
        import json
        import subprocess
        # Start the launcher directly, with no record_group from this process: if the record exists when the command
        # first runs, only the launcher in the new session can have written it, so no gap follows the fork.
        code = ("import json,os,sys;print(json.dumps({'pid':os.getpid(),'record':json.load(open(sys.argv[1]))}))")
        command = [sys.executable, "-c", code, str(self.control.group_file(JOB))]
        self.assertFalse(self.control.group_file(JOB).exists())
        process = subprocess.run(self.control.launcher(JOB, command), capture_output=True, text=True, timeout=10,
                                 start_new_session=True)
        self.assertEqual(process.returncode, 0, process.stderr)
        seen = json.loads(process.stdout)
        self.assertEqual(seen["record"]["pgid"], seen["pid"])

    def test_run_names_the_command_itself_in_the_record_and_forgets_it_afterwards(self):
        import json
        code = ("import json,os,sys;print(json.dumps({'pid':os.getpid(),'record':json.load(open(sys.argv[1]))}))")
        with self.control.job(JOB):
            completed = self.control.run(JOB, [sys.executable, "-c", code, str(self.control.group_file(JOB))], timeout=10)
        seen = json.loads(completed.stdout)
        self.assertEqual(seen["record"]["pgid"], seen["pid"])
        self.assertFalse(self.control.group_file(JOB).exists())

    def test_a_command_that_does_not_exist_still_raises_as_before(self):
        with self.control.job(JOB):
            with self.assertRaises(FileNotFoundError):
                self.control.run(JOB, ["/no/such/training-binary"], timeout=5)
        self.assertFalse(self.control.group_file(JOB).exists())

    def test_a_group_that_cannot_be_signalled_keeps_its_record_and_is_reported(self):
        from unittest import mock
        child = self.spawn()
        self.control.record_group(JOB, child)
        reaper = JobControl(self.control.root)
        with mock.patch("job_control.os.killpg", side_effect=PermissionError("denied")):
            self.assertEqual(reaper.reap_orphans(), [])
        self.assertTrue(self.control.group_file(JOB).exists())
        self.assertEqual(reaper.unreaped, [JOB + ".pgid"])
        self.assertIsNone(child.poll())

    def test_a_group_still_alive_after_sigkill_keeps_its_record_and_is_reported(self):
        from unittest import mock
        child = self.spawn()
        self.control.record_group(JOB, child)
        reaper = JobControl(self.control.root)
        with mock.patch("job_control.os.killpg"), mock.patch("job_control.REAP_WAIT_SECONDS", 0.2):
            self.assertEqual(reaper.reap_orphans(), [])
        self.assertTrue(self.control.group_file(JOB).exists())
        self.assertEqual(reaper.unreaped, [JOB + ".pgid"])
        # Once the group really is gone, the next start clears the record and reports nothing outstanding.
        os.killpg(child.pid, 9)
        child.wait()
        time.sleep(.3)
        again = JobControl(self.control.root)
        self.assertEqual(again.reap_orphans(), [])
        self.assertEqual(again.unreaped, [])
        self.assertFalse(self.control.group_file(JOB).exists())

    def test_an_unparseable_record_is_cleared_and_nothing_is_outstanding(self):
        self.control.root.mkdir(parents=True, exist_ok=True)
        self.control.group_file(JOB).write_text("not json")
        reaper = JobControl(self.control.root)
        self.assertEqual(reaper.reap_orphans(), [])
        self.assertEqual(reaper.unreaped, [])
        self.assertFalse(self.control.group_file(JOB).exists())


class PendingHandBackTests(unittest.TestCase):
    """A worker killed mid-job never reaches process_owned's `finally`; its replacement hands the tree back at start."""

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.control = JobControl(pathlib.Path(self.temp.name) / "control")
        self.output = pathlib.Path(self.temp.name) / "jobs" / JOB

    def root_written_tree(self):
        (self.output / "training" / "dataset").mkdir(parents=True)
        (self.output / "training" / "dataset" / "frame_00001.jpg").write_bytes(b"x")
        os.chown(self.output, 12345, 23456)

    @unittest.skipUnless(hasattr(os, "geteuid") and os.geteuid() == 0, "needs root to create foreign-owned files")
    def test_a_replacement_worker_hands_back_the_tree_of_a_job_its_predecessor_died_in(self):
        self.root_written_tree()
        self.control.pend_hand_back(JOB, self.output)
        # The worker is killed here: no settle_hand_back. A new process starts with the same control directory.
        restarted = JobControl(self.control.root)
        restarted.reap_orphans()
        self.assertEqual(restarted.finish_pending_hand_backs(), [JOB])
        for path in [self.output / "training", self.output / "training" / "dataset", self.output / "training" / "dataset" / "frame_00001.jpg"]:
            self.assertEqual((path.stat().st_uid, path.stat().st_gid), (12345, 23456), str(path))
        self.assertFalse(restarted.ownership_file(JOB).exists())
        self.assertEqual(restarted.finish_pending_hand_backs(), [])

    def test_the_record_is_flushed_to_disk_before_the_job_may_write_anything(self):
        self.output.mkdir(parents=True)
        events = []
        real_fsync, real_replace = os.fsync, os.replace
        with unittest.mock.patch.object(os, "fsync", lambda fd: (events.append("fsync"), real_fsync(fd))[1]), \
                unittest.mock.patch.object(os, "replace", lambda a, b: (events.append("replace"), real_replace(a, b))[1]):
            self.control.pend_hand_back(JOB, self.output)
        # The file contents are on disk before the rename publishes them; the directory entry is flushed after it.
        self.assertEqual(events, ["fsync", "replace", "fsync"])
        self.assertEqual(json.loads(self.control.ownership_file(JOB).read_text(encoding="utf-8")), {"directory": str(self.output)})

    @unittest.skipUnless(hasattr(os, "geteuid") and os.geteuid() == 0, "needs root to create foreign-owned files")
    def test_a_record_pointing_outside_the_configured_tree_root_is_dropped_not_replayed(self):
        inside_root = pathlib.Path(self.temp.name) / "jobs"
        elsewhere = pathlib.Path(self.temp.name) / "elsewhere"
        elsewhere.mkdir()
        os.chown(elsewhere, 12345, 23456)
        (elsewhere / "f").write_bytes(b"x")
        control = JobControl(self.control.root, tree_root=inside_root)
        control.pend_hand_back(JOB, elsewhere)
        self.assertEqual(control.finish_pending_hand_backs(), [])
        self.assertFalse(control.ownership_file(JOB).exists())
        self.assertEqual((elsewhere / "f").stat().st_uid, 0)
        # A tree inside the root is still handed back.
        self.root_written_tree()
        control.pend_hand_back(JOB, self.output)
        self.assertEqual(control.finish_pending_hand_backs(), [JOB])
        self.assertEqual((self.output / "training" / "dataset" / "frame_00001.jpg").stat().st_uid, 12345)

    def test_the_tree_root_itself_and_paths_outside_it_are_not_contained(self):
        control = JobControl(self.control.root, tree_root=self.temp.name)
        self.assertFalse(control.contains(self.temp.name))
        self.assertFalse(control.contains(pathlib.Path(self.temp.name).parent))
        self.assertFalse(control.contains(pathlib.Path(self.temp.name) / ".." / "x"))
        self.assertTrue(control.contains(pathlib.Path(self.temp.name) / "jobs" / JOB))
        self.assertTrue(JobControl(self.control.root).contains("/anywhere"))

    def test_a_finished_job_leaves_no_record(self):
        self.output.mkdir(parents=True)
        self.control.pend_hand_back(JOB, self.output)
        self.assertTrue(self.control.ownership_file(JOB).exists())
        self.control.settle_hand_back(JOB, self.output)
        self.assertFalse(self.control.ownership_file(JOB).exists())
        self.assertEqual(JobControl(self.control.root).finish_pending_hand_backs(), [])

    def test_a_job_whose_training_group_was_not_confirmed_ended_keeps_its_record(self):
        self.output.mkdir(parents=True)
        self.control.pend_hand_back(JOB, self.output)
        self.control.unreaped = [JOB + ".pgid"]
        self.assertEqual(self.control.finish_pending_hand_backs(), [])
        self.assertTrue(self.control.ownership_file(JOB).exists())

    def test_an_unreadable_record_is_dropped_without_raising(self):
        self.control.root.mkdir(parents=True)
        self.control.ownership_file(JOB).write_text("{not json", encoding="utf-8")
        self.assertEqual(self.control.finish_pending_hand_backs(), [])
        self.assertFalse(self.control.ownership_file(JOB).exists())

    def test_a_record_that_cannot_be_read_keeps_the_worker_from_promising_quiescence(self):
        self.control.root.mkdir(parents=True)
        # A directory where the record should be: reading it raises an OSError, as a failing disk would.
        self.control.ownership_file(JOB).mkdir()
        self.assertEqual(self.control.finish_pending_hand_backs(), [])
        self.assertEqual(self.control.unreaped, [JOB + ".owner"])
        self.assertTrue(self.control.ownership_file(JOB).exists())

    def test_a_temporary_record_left_by_a_kill_during_the_write_is_removed_at_start(self):
        self.control.root.mkdir(parents=True)
        stale = self.control.ownership_file(JOB).with_suffix(".owner.tmp")
        stale.write_text("{", encoding="utf-8")
        self.assertEqual(self.control.finish_pending_hand_backs(), [])
        self.assertFalse(stale.exists())
        self.assertEqual(self.control.unreaped, [])

    def test_a_missing_control_directory_or_job_tree_is_not_an_error(self):
        self.assertEqual(self.control.finish_pending_hand_backs(), [])
        self.control.pend_hand_back(JOB, self.output)
        self.assertEqual(self.control.finish_pending_hand_backs(), [JOB])
        self.assertFalse(self.control.ownership_file(JOB).exists())

    def test_the_record_rejects_a_job_id_that_is_not_a_uuid(self):
        with self.assertRaises(ValueError):
            self.control.pend_hand_back("../../etc", self.output)


if __name__ == "__main__":
    unittest.main()
