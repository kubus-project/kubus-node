"""Job-scoped cancellation. Tombstones prevent late requests recreating files."""
import contextlib
import json
import logging
import os
import pathlib
import re
import shutil
import signal
import stat
import subprocess
import sys
import threading
import time

log = logging.getLogger("kubus.worker.job_control")
REAP_WAIT_SECONDS = 5.0


class JobCancelled(Exception):
    pass


def boot_id():
    try:
        return pathlib.Path("/proc/sys/kernel/random/boot_id").read_text().strip()
    except OSError:
        return ""


def proc_fields(pid):
    """(session, start time in clock ticks, running) of a process from /proc, or None when it is gone or /proc is absent.

    `running` is False for a zombie: it has ended and only waits to be collected."""
    try:
        stat = pathlib.Path(f"/proc/{pid}/stat").read_text()
    except OSError:
        return None
    # The command name is parenthesised and may contain spaces; the fields after it are space separated.
    rest = stat[stat.rindex(")") + 2:].split()
    try:
        return int(rest[3]), int(rest[19]), rest[0] != "Z"
    except (IndexError, ValueError):
        return None


def process_start_time(pid):
    fields = proc_fields(pid)
    return fields[1] if fields else None


def group_alive_and_ours(group, start):
    """True when processes of session `group` exist and cannot be a later user of that process id.

    The session leader's pid cannot be reused while any member of its session lives. If the leader is alive its start
    time must match the recorded one; members of the session must have started no earlier than the leader did."""
    leader = proc_fields(group)
    if leader is not None and (leader[0] != group or leader[1] != start):
        return False
    found = leader is not None and leader[2]
    try:
        entries = os.listdir("/proc")
    except OSError:
        return False
    for entry in entries:
        if not entry.isdigit() or int(entry) == group:
            continue
        fields = proc_fields(int(entry))
        if fields and fields[0] == group:
            if fields[1] < start:
                return False
            found = found or fields[2]
    return found


def write_group_record(target, pgid, start):
    """Write the training-group record (id, start time, kernel boot id) atomically; False when it cannot be written."""
    target = pathlib.Path(target)
    try:
        target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
        temporary = target.with_suffix(".pgid.tmp")
        temporary.write_text(json.dumps({"pgid": pgid, "start": start, "boot": boot_id()}), encoding="utf-8")
        os.replace(temporary, target)
        return True
    except OSError:
        return False


def launch(record_path, command):
    """Runs in the new session, before the training command: record this process as the group leader, then exec.

    exec keeps the process id and start time, so the record written here is already the training group's. It closes
    the window in which a worker killed right after fork would leave a training process nobody recorded."""
    start = process_start_time(os.getpid())
    if start is not None:
        write_group_record(record_path, os.getpid(), start)
    try:
        os.execvp(command[0], command)
    except OSError as error:
        print(f"{command[0]}: {error.strerror or error}", file=sys.stderr)
        os._exit(127)


class JobControl:
    def __init__(self, root, tree_root=None):
        self.root = pathlib.Path(root)
        # When set, a recorded job tree is handed back only if it lies under this directory (the replay at start
        # trusts nothing it reads back from disk beyond the same containment the request path enforces).
        self.tree_root = pathlib.Path(tree_root).resolve() if tree_root else None
        self.lock = threading.RLock()
        self.active = {}
        # Record names (.pgid, .owner) of earlier jobs that start-up recovery could not settle: a training group not
        # confirmed ended, a hand-back record that could not be read, or a record directory that could not be listed
        # (named by its glob).
        self.unreaped = []

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
            process = subprocess.Popen(self.launcher(job_id, command), stdout=subprocess.PIPE,
                                       stderr=subprocess.PIPE, text=True,
                                       start_new_session=True)
            item["process"] = process
            self.record_group(job_id, process)
        try:
            out, err = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired:
            self.terminate(process)
            process.communicate()
            raise
        finally:
            with self.lock:
                item["process"] = None
                self.forget_group(job_id)
        if self.marker(job_id).exists():
            raise JobCancelled()
        return subprocess.CompletedProcess(command, process.returncode, out, err)

    def launcher(self, job_id, command):
        """The command, run through `launch` so its group is recorded from its first instruction.

        A command that cannot be found is passed through unchanged, so the caller still gets the FileNotFoundError
        Popen raises for it."""
        if not command or shutil.which(command[0]) is None:
            return command
        code = "import sys; sys.path.insert(0, sys.argv[1]); import job_control; job_control.launch(sys.argv[2], sys.argv[3:])"
        here = str(pathlib.Path(__file__).resolve().parent)
        return [sys.executable, "-c", code, here, str(self.group_file(job_id)), *command]

    def group_file(self, job_id):
        return self.root / (job_id + ".pgid")

    def record_group(self, job_id, process):
        """Remember the training process group so a replacement worker can end it if this one dies first."""
        start = process_start_time(process.pid)
        if start is not None:
            write_group_record(self.group_file(job_id), process.pid, start)

    def forget_group(self, job_id):
        try:
            self.group_file(job_id).unlink()
        except OSError:
            pass

    def ownership_file(self, job_id):
        return self.marker(job_id).with_suffix(".owner")

    def pend_hand_back(self, job_id, directory):
        """Durably remember, before a job writes anything, that its tree must go back to the Node's user.

        process_owned hands the tree back in its `finally`; a worker that is killed never gets there and leaves
        root-owned files the unprivileged Node cannot delete (EACCES), which blocks its cleanup journal for good.
        The record lets the replacement worker finish the hand-back at start. It is flushed to disk (file, then the
        directory entry) before this returns, like the cancellation tombstone, so a host crash cannot leave an empty
        record that start-up would drop. An I/O failure is logged, not raised; a job id that is not a uuid raises
        ValueError like every other job-scoped record."""
        target = self.ownership_file(job_id)
        try:
            target.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
            temporary = target.with_suffix(".owner.tmp")
            with temporary.open("w", encoding="utf-8") as handle:
                handle.write(json.dumps({"directory": str(directory)}))
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temporary, target)
            folder = os.open(target.parent, os.O_RDONLY)
            try:
                os.fsync(folder)
            finally:
                os.close(folder)
        except OSError as error:
            log.warning("cannot record the ownership hand-back for job %s: %s", job_id, error)

    def settle_hand_back(self, job_id, directory):
        """Hand the job's tree back now (the job has ended) and forget the record."""
        hand_back_ownership(directory)
        try:
            self.ownership_file(job_id).unlink()
        except OSError:
            pass

    def finish_pending_hand_backs(self):
        """At worker start, after reap_orphans: hand back the trees of jobs an earlier worker process died in.

        A job whose training group could not be confirmed ended (listed in `self.unreaped`) keeps its record: that
        group may still be writing, and the Node does not infer quiescence from this worker anyway. Returns the job
        ids whose trees were handed back."""
        done = []
        # A worker killed between writing and renaming a record leaves a temporary file; the job had written nothing yet.
        try:
            for stale in self.root.glob("*.owner.tmp"):
                stale.unlink(missing_ok=True)
        except OSError:
            pass
        try:
            records = sorted(self.root.glob("*.owner"))
        except OSError as error:
            # The records cannot be listed, so none were replayed: the trees may still be root-owned.
            log.warning("cannot list ownership hand-back records in %s: %s", self.root, error)
            self.unreaped.append("*.owner")
            return done
        for record in records:
            job_id = record.name[:-len(".owner")]
            if job_id + ".pgid" in self.unreaped:
                continue
            try:
                directory = json.loads(record.read_text(encoding="utf-8"))["directory"]
                if not isinstance(directory, str) or not directory:
                    raise ValueError("directory")
            except OSError as error:
                # Not settled: the tree may still be root-owned, so the Node must not infer quiescence from this worker.
                log.warning("cannot read ownership hand-back record %s: %s", record.name, error)
                self.unreaped.append(record.name)
                continue
            except (ValueError, KeyError, TypeError):
                log.warning("dropping unreadable ownership hand-back record %s", record.name)
                directory = None
            if directory and not self.contains(directory):
                log.warning("dropping ownership hand-back record %s: %r is outside %s", record.name, directory, self.tree_root)
                directory = None
            if directory:
                hand_back_ownership(directory)
                done.append(job_id)
            try:
                record.unlink()
            except OSError:
                pass
        return done

    def contains(self, directory):
        """Whether a recorded job directory may be handed back: always when no tree root is configured."""
        if self.tree_root is None:
            return True
        try:
            resolved = pathlib.Path(directory).resolve()
        except (OSError, RuntimeError, ValueError):
            return False
        return resolved != self.tree_root and self.tree_root in resolved.parents

    def reap_orphans(self):
        """At worker start: end any training process group a previous worker process left behind.

        A worker that restarts without its container (a supervisor restarting only uvicorn) would otherwise leave
        the training child, which runs in its own session, writing into a job directory the Node is about to
        delete. The Node treats a new worker instance id as proof the old process is gone; this makes it true.

        A record is removed only once its group is confirmed gone (or was never ours to signal). A group that could
        not be signalled, or that is still alive after SIGKILL (for example stuck in uninterruptible I/O), keeps its
        record for the next start and is listed in `self.unreaped`, which /health reports so the Node does not infer
        quiescence from this worker. Returns the process group ids that were ended."""
        reaped = []
        self.unreaped = []
        try:
            records = sorted(self.root.glob("*.pgid"))
        except OSError as error:
            # The records cannot be listed, so no group was checked: one may still be running.
            log.warning("cannot list training group records in %s: %s", self.root, error)
            self.unreaped.append("*.pgid")
            return reaped
        for record in records:
            try:
                data = json.loads(record.read_text(encoding="utf-8"))
                group, start = int(data["pgid"]), int(data["start"])
                mine = data.get("boot") == boot_id() and group_alive_and_ours(group, start)
            except OSError as error:
                log.warning("cannot read training group record %s: %s", record.name, error)
                self.unreaped.append(record.name)
                continue
            except (ValueError, KeyError, TypeError, AttributeError):
                mine = False
            if mine:
                try:
                    os.killpg(group, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                except OSError as error:
                    log.warning("cannot end orphaned training group %s: %s", group, error)
                    self.unreaped.append(record.name)
                    continue
                deadline = time.monotonic() + REAP_WAIT_SECONDS
                while group_alive_and_ours(group, start) and time.monotonic() < deadline:
                    time.sleep(0.05)
                if group_alive_and_ours(group, start):
                    log.warning("orphaned training group %s is still alive after SIGKILL", group)
                    self.unreaped.append(record.name)
                    continue
                reaped.append(group)
            try:
                record.unlink()
            except OSError:
                pass
        return reaped

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


def hand_back_ownership(directory):
    """Give a job's output tree to the owner of its top directory.

    The worker runs as root; the Node creates the job directory as its own
    unprivileged user and later deletes it during cleanup. Files left owned by
    root make that deletion fail with EACCES, which blocks the whole cleanup
    journal (and with it every later job). Best effort and symlink-safe: it
    never follows a link and never raises.

    The Node user can rename directories while this walks. Every directory is therefore held open by file
    descriptor and every entry is changed relative to it (fchownat without following links), so a directory swapped
    for a symlink after it was listed cannot redirect the change; nothing is addressed by a path that could be
    re-resolved.
    """
    try:
        # O_NOFOLLOW: a directory replaced by a symlink after a crash must not make this chown the link's target.
        top = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    except OSError:
        return
    try:
        info = os.fstat(top)
        if os.geteuid() != 0 or info.st_uid == 0:
            return
        os.chown(top, info.st_uid, info.st_gid)
        for _, directories, files, descriptor in os.fwalk(".", dir_fd=top, follow_symlinks=False):
            for name in directories + files:
                try:
                    os.chown(name, info.st_uid, info.st_gid, dir_fd=descriptor, follow_symlinks=False)
                except OSError:
                    pass
    except OSError:
        pass
    finally:
        os.close(top)
