"""Job-scoped cancellation. Tombstones prevent late requests recreating files."""
import contextlib
import os
import pathlib
import re
import signal
import subprocess
import threading
import time


class JobCancelled(Exception):
    pass


class JobControl:
    def __init__(self, root):
        self.root = pathlib.Path(root)
        self.lock = threading.RLock()
        self.active = {}

    def marker(self, job_id):
        if not re.fullmatch(r"[0-9a-fA-F-]{36}", job_id):
            raise ValueError("invalid_job_id")
        return self.root / (job_id + ".cancelled")

    @contextlib.contextmanager
    def job(self, job_id):
        with self.lock:
            if self.marker(job_id).exists():
                raise JobCancelled()
            if job_id in self.active:
                raise ValueError("job_already_running")
            item = {"done": threading.Event(), "process": None}
            self.active[job_id] = item
        try:
            yield
        finally:
            with self.lock:
                item["done"].set()
                self.active.pop(job_id, None)

    def run(self, job_id, command, timeout):
        # Serialize the tombstone check with process creation. Cancellation
        # can never acknowledge quiescence between these operations.
        with self.lock:
            item = self.active[job_id]
            if self.marker(job_id).exists():
                raise JobCancelled()
            process = subprocess.Popen(command, stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, text=True,
                                       start_new_session=True)
            item["process"] = process
        try:
            out, err = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.terminate(process)
            process.communicate()
            raise
        finally:
            with self.lock:
                item["process"] = None
        if self.marker(job_id).exists():
            raise JobCancelled()
        return subprocess.CompletedProcess(command, process.returncode, out, err)

    @staticmethod
    def terminate(process):
        if process.poll() is not None:
            return
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
            process.wait(timeout=5)

    def cancel(self, job_id, timeout=15):
        with self.lock:
            marker = self.marker(job_id)
            marker.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            # Persist the tombstone before returning an acknowledgement. It
            # survives worker restart and rejects an HTTP request arriving late.
            with marker.open("a", encoding="utf-8") as handle:
                handle.flush()
                os.fsync(handle.fileno())
            directory = os.open(marker.parent, os.O_RDONLY)
            try:
                os.fsync(directory)
            finally:
                os.close(directory)
            item = self.active.get(job_id)
            process = item["process"] if item else None
        if process:
            self.terminate(process)
        if item and not item["done"].wait(timeout):
            raise TimeoutError("worker_not_quiescent")
        return {"jobId": job_id, "quiescent": True, "cleanupProtocol": 1}
