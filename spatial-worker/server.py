import glob
import base64
import hashlib
import hmac
import json
import os
import pathlib
import shutil
import subprocess
import time
from typing import Any

import torch
from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel

import derivatives
from gpu_tier import classify_vram_tier
from splat_ply import splat_count
from worker_errors import WorkerError

WORKER_VERSION = "kubus-spatial-worker/2"
app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
WORKER_AUTH_KEY_PATH = os.environ.get("WORKER_AUTH_KEY_PATH", "/var/lib/kubus-node/worker-auth.key")
SHARED_ROOT = pathlib.Path(os.environ.get("KUBUS_SHARED_ROOT", "/var/lib/kubus-node"))


class ProcessRequest(BaseModel):
    jobId: str
    type: str
    captureDirectory: str
    outputDirectory: str
    input: dict[str, Any] = {}


def gpu_info() -> dict[str, Any]:
    available = bool(torch.cuda.is_available())
    properties = torch.cuda.get_device_properties(0) if available else None
    free_memory = torch.cuda.mem_get_info(0)[0] if available else None
    return {
        "available": available,
        "name": torch.cuda.get_device_name(0) if available else None,
        "vendor": "NVIDIA" if available else None,
        "model": torch.cuda.get_device_name(0) if available else None,
        "cuda": torch.version.cuda,
        "totalVramBytes": int(properties.total_memory) if properties else None,
        "usableVramBytes": int(free_memory) if free_memory else None,
        "tier": classify_vram_tier(properties.total_memory) if properties else None,
    }


def derivative_capabilities() -> list[str]:
    """Only what this image can really do: a missing tool is not advertised."""
    capabilities = []
    if derivatives.have_spz():
        capabilities.append("spatial.generate_preview")
    if derivatives.have_build_lod():
        capabilities.append("spatial.optimize")
    return capabilities


@app.get("/health")
def health() -> dict[str, Any]:
    gpu = gpu_info()
    tools = derivatives.tool_versions()
    if not gpu["available"]:
        return {
            "status": "unsupported",
            "gpu": gpu,
            "capabilities": [],
            "version": WORKER_VERSION,
            "tools": tools,
            "detail": "A CUDA-capable NVIDIA GPU is required for local reconstruction",
        }
    capabilities = ["spatial.reconstruct", "spatial.gaussianSplat", *derivative_capabilities()]
    result: dict[str, Any] = {"status": "ready", "gpu": gpu, "capabilities": capabilities, "version": WORKER_VERSION, "tools": tools}
    missing = [name for name in ("spatial.generate_preview", "spatial.optimize") if name not in capabilities]
    if missing:
        result["detail"] = "This worker image cannot create " + " or ".join(name.split(".")[1].replace("_", " ") for name in missing) + " derivatives"
    return result


def ensure_child(root: pathlib.Path, candidate: str) -> pathlib.Path:
    resolved = pathlib.Path(candidate).resolve()
    root = root.resolve()
    if resolved != root and root not in resolved.parents:
        raise WorkerError("path_outside_shared_runtime", "A path in the request leaves the shared runtime directory.", 400)
    return resolved


def decode_urlsafe(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def authorize_worker(token: str | None, request: ProcessRequest) -> None:
    if not token or "." not in token:
        raise HTTPException(status_code=401, detail="worker_authorization_required")
    try:
        payload_raw, signature = token.split(".", 1)
        secret = pathlib.Path(WORKER_AUTH_KEY_PATH).read_bytes()
        expected = base64.urlsafe_b64encode(hmac.new(secret, payload_raw.encode(), hashlib.sha256).digest()).decode().rstrip("=")
        if not hmac.compare_digest(signature, expected):
            raise ValueError("signature")
        payload = json.loads(decode_urlsafe(payload_raw))
        if payload.get("jobId") != request.jobId or payload.get("type") != request.type:
            raise ValueError("binding")
        now = int(time.time())
        if int(payload.get("exp", 0)) < now or int(payload.get("iat", now + 1)) > now + 30:
            raise ValueError("expiry")
    except (OSError, ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=401, detail="worker_authorization_invalid")


def master_path(output: pathlib.Path, request: ProcessRequest) -> pathlib.Path:
    """The master a derivative operation reads, named relative to the job's own directory."""
    relative = request.input.get("master")
    if not isinstance(relative, str) or not relative:
        raise WorkerError("master_missing", "The request did not name a reconstruction master.", 422)
    candidate = ensure_child(output, str(output / relative))
    if candidate.suffix.lower() != ".ply" or not candidate.is_file():
        raise WorkerError("master_missing", "The reconstruction master is not available to the worker.", 422)
    return candidate


def tail_to_log(label: str, completed: subprocess.CompletedProcess) -> None:
    # The tool's own words belong in the worker's log, where an operator debugging
    # a failure can find them; they are not an API response.
    print(f"[{label}] exit={completed.returncode}\n{(completed.stderr or completed.stdout or '')[-4000:]}", flush=True)


def reconstruct(request: ProcessRequest, capture: pathlib.Path, output: pathlib.Path) -> dict[str, Any]:
    if not torch.cuda.is_available():
        raise WorkerError("gpu_unsupported", "No CUDA GPU is available to the worker.", 503)
    transforms = capture / "transforms.json"
    if not transforms.is_file():
        raise WorkerError("capture_requires_nerfstudio_transforms_json", "The capture has not been converted to a training dataset.", 422)
    output.mkdir(parents=True, exist_ok=True)
    iterations = str(max(1000, min(int(os.environ.get("KUBUS_SPATIAL_MAX_ITERATIONS", "15000")), 30000)))
    started = time.monotonic()
    command = [
        "ns-train", "splatfacto", "--data", str(capture), "--output-dir", str(output / "training"),
        "--max-num-iterations", iterations, "--viewer.quit-on-train-completion", "True",
    ]
    completed = subprocess.run(command, check=False, text=True, capture_output=True, timeout=24 * 60 * 60)
    if completed.returncode != 0:
        tail_to_log("ns-train", completed)
        raise WorkerError("training_failed", "Reconstruction training failed; the worker log has the detail.", 500)
    trained = time.monotonic()
    configs = sorted(glob.glob(str(output / "training" / "**" / "config.yml"), recursive=True))
    if not configs:
        raise WorkerError("training_output_missing", "Training finished without a configuration to export from.", 500)
    export_dir = output / "export"
    export_dir.mkdir(exist_ok=True)
    export = subprocess.run(
        ["ns-export", "gaussian-splat", "--load-config", configs[-1], "--output-dir", str(export_dir)],
        check=False, text=True, capture_output=True, timeout=2 * 60 * 60,
    )
    if export.returncode != 0:
        tail_to_log("ns-export", export)
        raise WorkerError("export_failed", "Exporting the trained scene failed; the worker log has the detail.", 500)
    candidates = sorted(export_dir.glob("*.ply"))
    if not candidates:
        raise WorkerError("export_output_missing", "Export finished without writing a PLY.", 500)
    master = candidates[-1]
    # The checkpoints are only useful to the training that just finished; the
    # master is what every later step starts from. Freed now, before the
    # derivatives need the disk.
    shutil.rmtree(output / "training", ignore_errors=True)
    return {
        "variants": [{
            "role": "spatial_archive",
            "path": str(master.relative_to(output)),
            "mimeType": "application/octet-stream",
            "format": "ply",
            "storageClass": "cold",
        }],
        "measurements": {
            "masterBytes": master.stat().st_size,
            "masterSplats": splat_count(master),
            "trainingMs": int((trained - started) * 1000),
            "exportMs": int((time.monotonic() - trained) * 1000),
        },
        "viewerDefaults": {"quality": "auto"},
        "processing": {
            "protocol": "kubus.spatial-job/1",
            "workerVersion": WORKER_VERSION,
            "reconstruction": {"engine": "nerfstudio", "method": "splatfacto", "iterations": int(iterations), "outputFormat": "ply"},
        },
    }


def generate_preview(request: ProcessRequest, output: pathlib.Path) -> dict[str, Any]:
    master = master_path(output, request)
    result = derivatives.generate_preview(master, output / "preview")
    return {
        "variants": [{
            "role": "spatial_preview",
            "path": result["path"],
            "mimeType": "application/octet-stream",
            "format": "spz",
            "storageClass": "hot",
        }],
        "derivative": {key: result[key] for key in ("tool", "toolVersion", "sourceSplats", "splats", "sourceBytes", "bytes", "durationMs", "settings")},
        "processing": {"workerVersion": WORKER_VERSION},
    }


def optimize(request: ProcessRequest, output: pathlib.Path) -> dict[str, Any]:
    master = master_path(output, request)
    result = derivatives.build_runtime(master, output / "runtime")
    return {
        "variants": [{
            "role": "spatial_mobile",
            "bundle": {"directory": result["directory"], "entrypoint": result["entrypoint"], "files": result["files"]},
            "mimeType": "application/octet-stream",
            "format": "rad",
            "storageClass": "warm",
        }],
        "derivative": {key: result[key] for key in ("tool", "toolVersion", "sourceSplats", "splats", "sourceBytes", "bytes", "durationMs", "settings")},
        "processing": {"workerVersion": WORKER_VERSION},
    }


@app.post("/v1/process")
def process(request: ProcessRequest, x_kubus_worker_authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorize_worker(x_kubus_worker_authorization, request)
    try:
        capture = ensure_child(SHARED_ROOT, request.captureDirectory)
        output = ensure_child(SHARED_ROOT, request.outputDirectory)
        if request.type == "spatial.reconstruct":
            return reconstruct(request, capture, output)
        if request.type == "spatial.generate_preview":
            return generate_preview(request, output)
        if request.type == "spatial.optimize":
            return optimize(request, output)
        raise WorkerError("job_type_not_supported_by_worker", "This worker does not handle that job type.", 422)
    except WorkerError as error:
        raise HTTPException(status_code=error.status, detail=error.as_detail())
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail={"code": "worker_timeout", "message": "A processing step took too long and was stopped."})
