"""The worker's HTTP surface: authorisation, path confinement, dispatch and response shape.

`torch` is replaced by a stub (the module needs a CUDA build to import and these
tests are about the service, not the GPU). Reconstruction itself - `ns-train`
and `ns-export` on a real GPU - is not exercised here and is not claimed to be.

    python -m pytest spatial-worker
"""
from __future__ import annotations

import base64
import hashlib
import hmac
import json
import pathlib
import re
import sys
import time
import types

import pytest

fastapi_testclient = pytest.importorskip("fastapi.testclient", reason="fastapi/httpx are not installed")


class FakeCuda:
    """Switchable stand-in for `torch.cuda`."""

    def __init__(self) -> None:
        self.present = True
        self.total = 12 * 1024**3
        self.free = 10 * 1024**3

    def is_available(self) -> bool:
        return self.present

    def get_device_name(self, index: int) -> str:
        return "NVIDIA GeForce RTX 3080 Ti"

    def get_device_properties(self, index: int):
        return types.SimpleNamespace(total_memory=self.total)

    def mem_get_info(self, index: int):
        return (self.free, self.total)


CUDA = FakeCuda()
_torch = types.ModuleType("torch")
_torch.cuda = CUDA
_torch.version = types.SimpleNamespace(cuda="12.4")
sys.modules.setdefault("torch", _torch)

import derivatives  # noqa: E402
import server  # noqa: E402
from tool_fakes import FAKE_BUILD_LOD, FakeSpz  # noqa: E402
from worker_errors import WorkerError  # noqa: E402


@pytest.fixture(autouse=True)
def gpu(monkeypatch):
    CUDA.present, CUDA.total, CUDA.free = True, 12 * 1024**3, 10 * 1024**3
    monkeypatch.setattr(server.torch, "cuda", CUDA)
    yield CUDA


@pytest.fixture
def shared(tmp_path, monkeypatch):
    root = tmp_path / "shared"
    root.mkdir()
    key = tmp_path / "worker-auth.key"
    key.write_bytes(b"k" * 32)
    monkeypatch.setattr(server, "SHARED_ROOT", root)
    monkeypatch.setattr(server, "WORKER_AUTH_KEY_PATH", str(key))
    return root


@pytest.fixture
def client(shared):
    return fastapi_testclient.TestClient(server.app, raise_server_exceptions=False)


def b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode().rstrip("=")


def token(job_id: str, job_type: str, *, key: bytes = b"k" * 32, iat: int | None = None, exp: int | None = None) -> str:
    """A worker token in the format `src/spatial/workerAuth.ts` issues."""
    now = int(time.time())
    payload = {"v": 1, "jobId": job_id, "type": job_type, "iat": now if iat is None else iat, "exp": now + 300 if exp is None else exp, "nonce": "n"}
    raw = b64(json.dumps(payload).encode())
    return raw + "." + b64(hmac.new(key, raw.encode(), hashlib.sha256).digest())


def post(client, shared, job_type="spatial.generate_preview", job_id="job-1", *, auth="default", input=None, **overrides):
    output = shared / "jobs" / job_id / "output"
    output.mkdir(parents=True, exist_ok=True)
    body = {
        "jobId": job_id, "type": job_type, "captureDirectory": str(shared / "captures" / "c1"),
        "outputDirectory": str(output), "input": input if input is not None else {"master": "master.ply"},
    }
    body.update(overrides)
    headers = {}
    if auth == "default":
        headers["X-Kubus-Worker-Authorization"] = token(job_id, job_type)
    elif auth is not None:
        headers["X-Kubus-Worker-Authorization"] = auth
    return client.post("/v1/process", json=body, headers=headers)


def place_master(shared, make_master, job_id="job-1") -> pathlib.Path:
    output = shared / "jobs" / job_id / "output"
    output.mkdir(parents=True, exist_ok=True)
    source = make_master(3000)
    target = output / "master.ply"
    target.write_bytes(source.read_bytes())
    return target


# --- /health -----------------------------------------------------------------

def test_health_without_a_gpu_is_unsupported_and_advertises_nothing(client, gpu):
    gpu.present = False
    body = client.get("/health").json()
    assert body["status"] == "unsupported" and body["capabilities"] == []
    assert body["gpu"]["available"] is False and body["gpu"]["tier"] is None


def test_health_with_a_gpu_reports_reconstruction_and_only_the_derivatives_it_can_make(client, monkeypatch):
    monkeypatch.setattr(derivatives, "have_spz", lambda: True)
    monkeypatch.setattr(derivatives, "have_build_lod", lambda: True)
    body = client.get("/health").json()
    assert body["status"] == "ready"
    assert body["capabilities"] == ["spatial.reconstruct", "spatial.gaussianSplat", "spatial.generate_preview", "spatial.optimize"]
    assert "detail" not in body
    assert body["gpu"]["tier"] == "12GB+" and body["gpu"]["vendor"] == "NVIDIA"


@pytest.mark.parametrize("spz,lod,advertised,missing", [
    (True, False, ["spatial.generate_preview"], "optimize"),
    (False, True, ["spatial.optimize"], "generate preview"),
    (False, False, [], "generate preview or optimize"),
])
def test_a_missing_tool_is_not_advertised_and_is_named_in_the_detail(client, monkeypatch, spz, lod, advertised, missing):
    monkeypatch.setattr(derivatives, "have_spz", lambda: spz)
    monkeypatch.setattr(derivatives, "have_build_lod", lambda: lod)
    body = client.get("/health").json()
    assert body["status"] == "ready"
    assert [name for name in body["capabilities"] if name not in ("spatial.reconstruct", "spatial.gaussianSplat")] == advertised
    assert missing in body["detail"]


def test_health_reports_the_pinned_tool_versions(client, tmp_path, monkeypatch):
    manifest = tmp_path / "tools.json"
    manifest.write_text('{"spz": {"version": "v3.0.0"}}')
    monkeypatch.setattr(derivatives, "TOOLS_MANIFEST", manifest)
    assert client.get("/health").json()["tools"] == {"spz": {"version": "v3.0.0"}}


# --- path confinement --------------------------------------------------------

def test_ensure_child_accepts_the_root_and_things_below_it(tmp_path):
    root = tmp_path / "root"
    (root / "a").mkdir(parents=True)
    assert server.ensure_child(root, str(root)) == root.resolve()
    assert server.ensure_child(root, str(root / "a" / "b.ply")) == (root / "a" / "b.ply").resolve()


@pytest.mark.parametrize("candidate", ["{root}/../outside", "{root}/a/../../outside", "/etc/passwd", "{root}-sibling/x"])
def test_ensure_child_refuses_everything_that_leaves_the_root(tmp_path, candidate):
    root = tmp_path / "root"
    (root / "a").mkdir(parents=True)
    with pytest.raises(WorkerError) as caught:
        server.ensure_child(root, candidate.format(root=root))
    assert (caught.value.code, caught.value.status) == ("path_outside_shared_runtime", 400)


def test_ensure_child_follows_symlinks_before_judging(tmp_path):
    root, outside = tmp_path / "root", tmp_path / "outside"
    root.mkdir(), outside.mkdir()
    (root / "link").symlink_to(outside)
    with pytest.raises(WorkerError):
        server.ensure_child(root, str(root / "link" / "file.ply"))


def test_master_path_must_name_a_ply_inside_the_job_output(shared, make_master):
    output = shared / "jobs" / "j" / "output"
    output.mkdir(parents=True)
    master = output / "export" / "splat.ply"
    master.parent.mkdir()
    master.write_bytes(make_master(1200).read_bytes())
    request = lambda value: server.ProcessRequest(jobId="j", type="spatial.optimize", captureDirectory="x", outputDirectory=str(output), input=value)  # noqa: E731

    assert server.master_path(output, request({"master": "export/splat.ply"})) == master.resolve()
    for bad in [{}, {"master": ""}, {"master": 7}, {"master": "export/absent.ply"}, {"master": "export"}]:
        with pytest.raises(WorkerError) as caught:
            server.master_path(output, request(bad))
        assert caught.value.code == "master_missing", bad
    with pytest.raises(WorkerError) as outside:
        server.master_path(output, request({"master": "../../../../etc/passwd"}))
    assert outside.value.code in {"path_outside_shared_runtime", "master_missing"}
    (output / "notes.txt").write_text("x")
    with pytest.raises(WorkerError) as not_ply:
        server.master_path(output, request({"master": "notes.txt"}))
    assert not_ply.value.code == "master_missing"


# --- authorisation -----------------------------------------------------------

def test_a_request_without_a_token_is_refused_before_anything_is_read(client, shared):
    response = post(client, shared, auth=None)
    assert response.status_code == 401 and response.json()["detail"] == "worker_authorization_required"


@pytest.mark.parametrize("value", ["", "nodot"])
def test_a_malformed_token_is_refused(client, shared, value):
    assert post(client, shared, auth=value).status_code == 401


@pytest.mark.parametrize("label,build", [
    ("another key", lambda: token("job-1", "spatial.generate_preview", key=b"x" * 32)),
    ("another job", lambda: token("job-2", "spatial.generate_preview")),
    ("another type", lambda: token("job-1", "spatial.optimize")),
    ("expired", lambda: token("job-1", "spatial.generate_preview", iat=int(time.time()) - 900, exp=int(time.time()) - 600)),
    ("issued in the future", lambda: token("job-1", "spatial.generate_preview", iat=int(time.time()) + 600, exp=int(time.time()) + 900)),
    ("truncated signature", lambda: token("job-1", "spatial.generate_preview")[:-6]),
    ("payload tampered", lambda: b64(json.dumps({"jobId": "job-1", "type": "spatial.generate_preview", "iat": 0, "exp": 9999999999}).encode()) + "." + token("job-1", "spatial.generate_preview").split(".")[1]),
])
def test_a_token_that_is_not_for_exactly_this_job_now_is_refused(client, shared, label, build):
    response = post(client, shared, auth=build())
    assert response.status_code == 401, label
    assert response.json()["detail"] == "worker_authorization_invalid", label


def test_a_validly_signed_non_json_payload_is_refused_not_a_server_error(client, shared):
    raw = b64(b"\xff\xfe not json")
    signed = raw + "." + b64(hmac.new(b"k" * 32, raw.encode(), hashlib.sha256).digest())
    assert post(client, shared, auth=signed).status_code == 401


def test_a_worker_with_no_key_file_refuses_every_request(client, shared, monkeypatch, tmp_path):
    monkeypatch.setattr(server, "WORKER_AUTH_KEY_PATH", str(tmp_path / "missing.key"))
    assert post(client, shared).status_code == 401


def test_a_refused_request_does_no_work(client, shared, monkeypatch):
    called = []
    monkeypatch.setattr(derivatives, "generate_preview", lambda *args, **kwargs: called.append(args))
    post(client, shared, auth="bad.token")
    assert called == []


# --- dispatch and response shape ---------------------------------------------

BUNDLE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")  # src/utils or spatial isBundleFileName, restated


def test_a_preview_request_returns_the_shape_the_node_imports(client, shared, make_master, monkeypatch):
    monkeypatch.setitem(sys.modules, "spz", FakeSpz().module())
    place_master(shared, make_master)
    response = post(client, shared, "spatial.generate_preview")
    assert response.status_code == 200, response.text
    body = response.json()
    assert body["variants"] == [{
        "role": "spatial_preview", "path": "preview/preview.spz", "mimeType": "application/octet-stream", "format": "spz", "storageClass": "hot",
    }]
    assert set(body["derivative"]) == {"tool", "toolVersion", "sourceSplats", "splats", "sourceBytes", "bytes", "durationMs", "settings"}
    assert body["derivative"]["tool"] == "spz" and body["derivative"]["settings"]["spzVersion"] == 3
    assert (shared / "jobs" / "job-1" / "output" / body["variants"][0]["path"]).is_file()


def test_an_optimize_request_returns_a_bundle_variant_and_no_single_file_path(client, shared, make_master, monkeypatch, tmp_path, tools_manifest):
    import os
    import stat
    script = tmp_path / "bin" / "build-lod"
    script.parent.mkdir()
    script.write_text(FAKE_BUILD_LOD.format(python=sys.executable))
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setattr(derivatives, "BUILD_LOD_BINARY", str(script))
    monkeypatch.setenv("FAKE_ARGS", str(tmp_path / "args.json"))
    monkeypatch.setenv("FAKE_MODE", "ok")
    place_master(shared, make_master)

    response = post(client, shared, "spatial.optimize")
    assert response.status_code == 200, response.text
    variant = response.json()["variants"][0]
    assert variant["role"] == "spatial_mobile" and variant["format"] == "rad" and variant["storageClass"] == "warm"
    assert "path" not in variant and "cid" not in variant
    bundle = variant["bundle"]
    assert set(bundle) == {"directory", "entrypoint", "files"}
    assert bundle["entrypoint"] in bundle["files"] and all(BUNDLE_NAME.match(name) for name in bundle["files"])
    on_disk = sorted(path.name for path in (shared / "jobs" / "job-1" / "output" / bundle["directory"]).iterdir())
    assert on_disk == sorted(bundle["files"]), "the node refuses a listing that differs from the directory"
    assert response.json()["derivative"]["tool"] == "build-lod" and os.path.exists(tmp_path / "args.json")


def test_the_storage_class_follows_the_role_the_worker_returns(client, shared, make_master, monkeypatch):
    monkeypatch.setitem(sys.modules, "spz", FakeSpz().module())
    place_master(shared, make_master)
    assert post(client, shared).json()["variants"][0]["storageClass"] == "hot"


def test_a_worker_failure_reaches_the_caller_as_a_code_and_a_sentence(client, shared, make_master, monkeypatch):
    monkeypatch.setitem(sys.modules, "spz", FakeSpz(save_result=False).module())
    place_master(shared, make_master)
    response = post(client, shared)
    assert response.status_code == 500
    assert response.json()["detail"] == {"code": "preview_failed", "message": "The SPZ encoder could not write the preview."}


def test_a_request_for_a_master_that_is_not_there_is_a_422_with_a_code(client, shared):
    response = post(client, shared, "spatial.optimize")
    assert response.status_code == 422 and response.json()["detail"]["code"] == "master_missing"


def test_an_unknown_job_type_is_refused_with_a_code(client, shared):
    response = post(client, shared, "spatial.teleport")
    assert response.status_code == 422 and response.json()["detail"]["code"] == "job_type_not_supported_by_worker"


@pytest.mark.parametrize("field", ["captureDirectory", "outputDirectory"])
def test_a_directory_outside_the_shared_root_is_refused_even_for_an_authorised_job(client, shared, field):
    response = post(client, shared, **{field: "/etc"})
    assert response.status_code == 400 and response.json()["detail"]["code"] == "path_outside_shared_runtime"


def test_a_timeout_is_a_504_with_a_code(client, shared, make_master, monkeypatch):
    place_master(shared, make_master)

    def slow(*args, **kwargs):
        raise server.subprocess.TimeoutExpired("build-lod", 1)

    monkeypatch.setattr(derivatives, "build_runtime", slow)
    response = post(client, shared, "spatial.optimize")
    assert response.status_code == 504 and response.json()["detail"]["code"] == "worker_timeout"


def test_reconstruction_without_a_gpu_is_a_503_and_never_starts_a_process(client, shared, gpu, monkeypatch):
    gpu.present = False
    started = []
    monkeypatch.setattr(server.subprocess, "run", lambda *args, **kwargs: started.append(args))
    response = post(client, shared, "spatial.reconstruct", input={})
    assert response.status_code == 503 and response.json()["detail"]["code"] == "gpu_unsupported"
    assert started == []


def test_reconstruction_of_a_capture_without_a_training_dataset_is_a_422(client, shared):
    (shared / "captures" / "c1").mkdir(parents=True)
    response = post(client, shared, "spatial.reconstruct", input={})
    assert response.status_code == 422 and response.json()["detail"]["code"] == "capture_requires_nerfstudio_transforms_json"


def test_a_failed_training_run_is_reported_by_code_and_the_tools_output_goes_to_the_log(client, shared, monkeypatch, capsys):
    (shared / "captures" / "c1").mkdir(parents=True)
    (shared / "captures" / "c1" / "transforms.json").write_text("{}")
    completed = types.SimpleNamespace(returncode=1, stdout="", stderr="CUDA out of memory: tried to allocate 20 GiB")
    monkeypatch.setattr(server.subprocess, "run", lambda *args, **kwargs: completed)
    response = post(client, shared, "spatial.reconstruct", input={})
    assert response.status_code == 500 and response.json()["detail"]["code"] == "training_failed"
    assert "CUDA out of memory" not in response.text, "tool output is for the worker log, not the API"
    assert "CUDA out of memory" in capsys.readouterr().out


def test_a_successful_reconstruction_hands_back_the_master_as_the_archive(client, shared, make_master, monkeypatch):
    capture = shared / "captures" / "c1"
    capture.mkdir(parents=True)
    (capture / "transforms.json").write_text("{}")
    output = shared / "jobs" / "job-1" / "output"
    output.mkdir(parents=True)
    master_bytes = make_master(1500).read_bytes()
    commands = []

    def run(command, **kwargs):
        commands.append(command[0])
        if command[0] == "ns-train":
            config = output / "training" / "run" / "config.yml"
            config.parent.mkdir(parents=True)
            config.write_text("x")
        else:
            (output / "export").mkdir(exist_ok=True)
            (output / "export" / "splat.ply").write_bytes(master_bytes)
        return types.SimpleNamespace(returncode=0, stdout="", stderr="")

    monkeypatch.setattr(server.subprocess, "run", run)
    response = post(client, shared, "spatial.reconstruct", input={})
    assert response.status_code == 200, response.text
    body = response.json()
    assert commands == ["ns-train", "ns-export"]
    assert body["variants"] == [{"role": "spatial_archive", "path": "export/splat.ply", "mimeType": "application/octet-stream", "format": "ply", "storageClass": "cold"}]
    assert body["measurements"]["masterSplats"] == 1500 and body["measurements"]["masterBytes"] == len(master_bytes)
    assert not (output / "training").exists(), "checkpoints are freed once the master exists"
    assert body["processing"]["workerVersion"] == server.WORKER_VERSION
