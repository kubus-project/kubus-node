import glob
import base64
import hashlib
import hmac
import json
import os
import pathlib
import subprocess
from typing import Any

import torch
from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
WORKER_AUTH_KEY_PATH = os.environ.get("WORKER_AUTH_KEY_PATH", "/var/lib/kubus-node/worker-auth.key")


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
        "tier": ("24GB+" if properties and properties.total_memory >= 24 * 1024**3 else "12GB+" if properties and properties.total_memory >= 12 * 1024**3 else "8GB+") if properties else None,
    }


@app.get("/health")
def health() -> dict[str, Any]:
    gpu = gpu_info()
    if not gpu["available"]:
        return {
            "status": "unsupported",
            "gpu": gpu,
            "capabilities": [],
            "version": "kubus-spatial-worker/1",
            "detail": "A CUDA-capable NVIDIA GPU is required for local reconstruction",
        }
    return {
        "status": "ready",
        "gpu": gpu,
        "capabilities": ["spatial.reconstruct", "spatial.gaussianSplat"],
        "version": "kubus-spatial-worker/1",
    }


def ensure_child(root: pathlib.Path, candidate: str) -> pathlib.Path:
    resolved = pathlib.Path(candidate).resolve()
    if resolved != root and root not in resolved.parents:
        raise HTTPException(status_code=400, detail="path_outside_shared_runtime")
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
        now = int(__import__("time").time())
        if int(payload.get("exp", 0)) < now or int(payload.get("iat", now + 1)) > now + 30:
            raise ValueError("expiry")
    except (OSError, ValueError, TypeError, json.JSONDecodeError, UnicodeDecodeError):
        raise HTTPException(status_code=401, detail="worker_authorization_invalid")


@app.post("/v1/process")
def process(request: ProcessRequest, x_kubus_worker_authorization: str | None = Header(default=None)) -> dict[str, Any]:
    authorize_worker(x_kubus_worker_authorization, request)
    if not torch.cuda.is_available():
        raise HTTPException(status_code=503, detail="gpu_unsupported")
    shared_root = pathlib.Path("/var/lib/kubus-node").resolve()
    capture = ensure_child(shared_root, request.captureDirectory)
    output = ensure_child(shared_root, request.outputDirectory)
    if request.type != "spatial.reconstruct":
        raise HTTPException(status_code=422, detail="job_type_not_supported_by_worker")
    transforms = capture / "transforms.json"
    if not transforms.is_file():
        raise HTTPException(status_code=422, detail="capture_requires_nerfstudio_transforms_json")
    output.mkdir(parents=True, exist_ok=True)
    iterations = str(max(1000, min(int(os.environ.get("KUBUS_SPATIAL_MAX_ITERATIONS", "15000")), 30000)))
    command = [
        "ns-train", "splatfacto", "--data", str(capture), "--output-dir", str(output / "training"),
        "--max-num-iterations", iterations, "--viewer.quit-on-train-completion", "True",
    ]
    completed = subprocess.run(command, check=False, text=True, capture_output=True, timeout=24 * 60 * 60)
    if completed.returncode != 0:
        raise HTTPException(status_code=500, detail=(completed.stderr or completed.stdout)[-2000:])
    configs = sorted(glob.glob(str(output / "training" / "**" / "config.yml"), recursive=True))
    if not configs:
        raise HTTPException(status_code=500, detail="training_config_not_found")
    export_dir = output / "export"
    export_dir.mkdir(exist_ok=True)
    export = subprocess.run(
        ["ns-export", "gaussian-splat", "--load-config", configs[-1], "--output-dir", str(export_dir)],
        check=False, text=True, capture_output=True, timeout=2 * 60 * 60,
    )
    if export.returncode != 0:
        raise HTTPException(status_code=500, detail=(export.stderr or export.stdout)[-2000:])
    candidates = sorted(export_dir.glob("*.ply"))
    if not candidates:
        raise HTTPException(status_code=500, detail="gaussian_export_not_found")
    return {
        "variants": [{
            "role": "spatial_archive",
            "path": str(candidates[-1].relative_to(output)),
            "mimeType": "application/octet-stream",
            "format": "ply",
            "storageClass": "cold",
        }],
        "viewerDefaults": {"quality": "archive"},
        "processing": {
            "protocol": "kubus.spatial-job/1",
            "workerVersion": "kubus-spatial-worker/1",
            "reconstruction": {
                "engine": "nerfstudio",
                "method": "splatfacto",
                "iterations": int(iterations),
                "outputFormat": "ply",
            },
        },
    }
