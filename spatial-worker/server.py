import glob
import asyncio
import base64
import hashlib
import hmac
import json
import os
import pathlib
import time
import uuid
from typing import Any

import torch
from fastapi import FastAPI, HTTPException, Header
from pydantic import BaseModel

from gpu_tier import classify_vram_tier
from job_control import JobControl, JobCancelled, hand_back_ownership
from face_mask import FaceMaskingError, masking_provenance
from photo_pipeline import prepare_photo_dataset
from scene_frame import analyse_dataset
from video_pipeline import WorkerError, prepare_video_dataset

app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None)
WORKER_AUTH_KEY_PATH = os.environ.get("WORKER_AUTH_KEY_PATH", "/var/lib/kubus-node/worker-auth.key")


WORKER_VERSION = "kubus-spatial-worker/9"
WORKER_INSTANCE_ID = str(uuid.uuid4())
control = JobControl("/var/lib/kubus-node/private/worker-control")


class JobRequest(BaseModel):
    jobId: str
    type: str
    workerInstanceId: str


class ProcessRequest(JobRequest):
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


@app.get("/health")
def health() -> dict[str, Any]:
    gpu = gpu_info()
    if not gpu["available"]:
        return {
            "status": "unsupported",
            "gpu": gpu,
            "capabilities": [],
            "version": WORKER_VERSION,
            "cleanupProtocol": 1,
            "workerInstanceId": WORKER_INSTANCE_ID,
            "detail": "A CUDA-capable NVIDIA GPU is required for local reconstruction",
        }
    return {
        "status": "ready",
        "gpu": gpu,
        "capabilities": ["spatial.reconstruct", "spatial.gaussianSplat"],
        # Input modes `spatial.reconstruct` accepts: posed frames, one video, still photos, or photos plus one video.
        "inputModes": ["frames", "video", "photos", "mixed"],
        # Face masking of photos and video frames before reconstruction (`input.maskFaces`); see face_mask.py.
        "faceMasking": True,
        "version": WORKER_VERSION,
        "cleanupProtocol": 1,
        "workerInstanceId": WORKER_INSTANCE_ID,
    }


def ensure_child(root: pathlib.Path, candidate: str) -> pathlib.Path:
    resolved = pathlib.Path(candidate).resolve()
    if resolved != root and root not in resolved.parents:
        raise HTTPException(status_code=400, detail="path_outside_shared_runtime")
    return resolved


def decode_urlsafe(value: str) -> bytes:
    return base64.urlsafe_b64decode(value + "=" * (-len(value) % 4))


def authorize_worker(token: str | None, request: JobRequest) -> None:
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
    if request.workerInstanceId != WORKER_INSTANCE_ID:
        raise HTTPException(status_code=409, detail="worker_instance_changed")
    try:
        with control.job(request.jobId):
            return process_owned(request)
    except JobCancelled:
        raise HTTPException(status_code=409, detail="job_cancelled")
    except FaceMaskingError as error:
        # Masking could not run: nothing may continue with unmasked pixels.
        raise HTTPException(status_code=500, detail={"code": "face_masking_failed", "message": str(error)})
    except WorkerError as error:
        # `detail` is an object with a stable `code`; the Node reads it.
        raise HTTPException(status_code=error.status, detail=error.detail())
    except ValueError:
        raise HTTPException(status_code=409, detail="job_identity_invalid_or_active")


@app.post("/v1/jobs/cancel")
async def cancel(request: JobRequest, x_kubus_worker_authorization: str | None = Header(default=None)):
    authorize_worker(x_kubus_worker_authorization, request)
    if request.workerInstanceId != WORKER_INSTANCE_ID:
        raise HTTPException(status_code=409, detail="worker_instance_changed")
    try:
        return {**(await asyncio.to_thread(control.cancel, request.jobId)), "workerInstanceId": WORKER_INSTANCE_ID}
    except ValueError:
        raise HTTPException(status_code=400, detail="job_identity_invalid")
    except TimeoutError:
        raise HTTPException(status_code=503, detail="worker_not_quiescent")


def write_progress(output: pathlib.Path, stage: str, detail: dict | None = None) -> None:
    """Publish the current stage where the Node can read it while the request is in flight."""
    output.mkdir(parents=True, exist_ok=True)
    target = output / "worker-progress.json"
    temporary = output / "worker-progress.json.tmp"
    temporary.write_text(json.dumps({
        "stage": stage, "detail": detail or {}, "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }), encoding="utf-8")
    os.replace(temporary, target)


def ply_vertex_count(path: pathlib.Path) -> int | None:
    try:
        with path.open("rb") as handle:
            for _ in range(200):
                line = handle.readline()
                if line.startswith(b"element vertex "):
                    return int(line.split()[2])
                if line.startswith(b"end_header"):
                    break
    except (OSError, ValueError, IndexError):
        return None
    return None


def wants_floater_crop(request: ProcessRequest) -> bool:
    """Per-job `floaterCrop` wins; otherwise the worker's `KUBUS_SPATIAL_FLOATER_CROP` default (off)."""
    requested = request.input.get("floaterCrop")
    if isinstance(requested, bool):
        return requested
    return os.environ.get("KUBUS_SPATIAL_FLOATER_CROP", "0") == "1"


def process_owned(request: ProcessRequest):
    try:
        return run_reconstruction(request)
    finally:
        # Success, failure or cancellation: the Node must be able to delete what this root process wrote.
        hand_back_ownership(request.outputDirectory)


def run_reconstruction(request: ProcessRequest):
    if not torch.cuda.is_available():
        raise HTTPException(status_code=503, detail="gpu_unsupported")
    shared_root = pathlib.Path("/var/lib/kubus-node").resolve()
    capture = ensure_child(shared_root, request.captureDirectory)
    output = ensure_child(shared_root, request.outputDirectory)
    if request.type != "spatial.reconstruct":
        raise HTTPException(status_code=422, detail="job_type_not_supported_by_worker")
    mode = request.input.get("mode") or "frames"
    if mode not in ("frames", "video", "photos", "mixed"):
        raise HTTPException(status_code=422, detail="input_mode_not_supported_by_worker")
    output.mkdir(parents=True, exist_ok=True)
    provenance: dict[str, Any] = {}
    timings: dict[str, float] = {}
    started = time.monotonic()
    runner = lambda command, timeout: control.run(request.jobId, command, timeout=timeout)
    progress = lambda stage, detail: write_progress(output, stage, detail)
    mask = request.input.get("maskFaces")
    mask_photos = isinstance(mask, dict) and mask.get("photos") is True
    mask_video = isinstance(mask, dict) and mask.get("video") is True
    if mode == "video":
        prepared = prepare_video_dataset(runner, capture, output, progress, mask_video=mask_video)
        dataset = prepared["dataset"]
        provenance = {"kind": "video", "video": prepared["video"], "frames": prepared["frames"], "sfm": prepared["sfm"]}
        masked = masking_provenance(prepared["masking"])
        if masked:
            provenance["faceMasking"] = masked
    elif mode in ("photos", "mixed"):
        prepared = prepare_photo_dataset(runner, capture, output, progress, include_video=(mode == "mixed"), mask_photos=mask_photos, mask_video=mask_video)
        dataset = prepared["dataset"]
        provenance = {"kind": mode, "photos": prepared["photos"], "sfm": prepared["sfm"]}
        masked = masking_provenance(prepared["masking"])
        if masked:
            provenance["faceMasking"] = masked
        if prepared["video"]:
            provenance["video"] = prepared["video"]
            provenance["frames"] = prepared["frames"]
    else:
        dataset = capture
        if not (dataset / "transforms.json").is_file():
            raise HTTPException(status_code=422, detail="capture_requires_nerfstudio_transforms_json")
    timings["intake"] = round(time.monotonic() - started, 1)
    iterations = str(max(1000, min(int(os.environ.get("KUBUS_SPATIAL_MAX_ITERATIONS", "15000")), 30000)))
    write_progress(output, "training", {"iterations": int(iterations)})
    command = [
        "ns-train", "splatfacto", "--data", str(dataset), "--output-dir", str(output / "training"),
        "--max-num-iterations", iterations, "--viewer.quit-on-train-completion", "True",
    ]
    trained_at = time.monotonic()
    completed = control.run(request.jobId, command, timeout=24 * 60 * 60)
    timings["training"] = round(time.monotonic() - trained_at, 1)
    if completed.returncode != 0:
        raise HTTPException(status_code=500, detail=(completed.stderr or completed.stdout)[-2000:])
    configs = sorted(glob.glob(str(output / "training" / "**" / "config.yml"), recursive=True))
    if not configs:
        raise HTTPException(status_code=500, detail="training_config_not_found")
    # Orientation and the crop box come from the COLMAP solution, mapped into the frame the splat is written in.
    analysis: dict[str, Any] | None = None
    if mode != "frames":
        try:
            analysis = analyse_dataset(dataset / "transforms.json", dataset / "sparse_pc.ply", pathlib.Path(configs[-1]).parent / "dataparser_transforms.json")
        except Exception as error:  # orientation is a convenience; it must never fail a finished training run
            provenance["orientation"] = {"method": "unavailable", "error": type(error).__name__}
    write_progress(output, "exporting", {})
    export_dir = output / "export"
    export_dir.mkdir(exist_ok=True)
    exported_at = time.monotonic()
    export = control.run(request.jobId,
        ["ns-export", "gaussian-splat", "--load-config", configs[-1], "--output-dir", str(export_dir)],
        timeout=2 * 60 * 60,
    )
    if export.returncode != 0:
        raise HTTPException(status_code=500, detail=(export.stderr or export.stdout)[-2000:])
    candidates = sorted(export_dir.glob("*.ply"))
    if not candidates:
        raise HTTPException(status_code=500, detail="gaussian_export_not_found")
    chosen = candidates[-1]
    crop: dict[str, Any] | None = None
    if wants_floater_crop(request):
        crop = {"applied": False}
        if analysis and analysis.get("box"):
            box = analysis["box"]
            centre = [(lo + hi) / 2.0 for lo, hi in zip(box["min"], box["max"])]
            size = [hi - lo for lo, hi in zip(box["min"], box["max"])]
            cropped = control.run(request.jobId, [
                "ns-export", "gaussian-splat", "--load-config", configs[-1], "--output-dir", str(export_dir),
                "--output-filename", "splat-cropped.ply",
                "--obb-center", *[f"{value:.6f}" for value in centre],
                "--obb-rotation", "0", "0", "0",
                "--obb-scale", *[f"{value:.6f}" for value in size],
            ], timeout=2 * 60 * 60)
            before, after = ply_vertex_count(chosen), ply_vertex_count(export_dir / "splat-cropped.ply")
            if cropped.returncode == 0 and after:
                crop = {**box, "applied": True, "splatsBefore": before, "splatsAfter": after, "rotation": [0, 0, 0]}
                chosen = export_dir / "splat-cropped.ply"
            else:
                crop = {"applied": False, "reason": "crop_export_failed", "splatsBefore": before}
        else:
            crop = {"applied": False, "reason": "no_subject_box"}
    timings["export"] = round(time.monotonic() - exported_at, 1)
    provenance["timings"] = timings
    if analysis:
        provenance["orientation"] = {key: value for key, value in analysis["orientation"].items() if not isinstance(value, list)}
    if crop is not None:
        provenance["crop"] = {key: value for key, value in crop.items() if not isinstance(value, (list, dict))}
    splats = ply_vertex_count(chosen)
    if splats is not None:
        provenance["splatCount"] = splats
    candidates = [chosen]
    result: dict[str, Any] = {
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
            "workerVersion": WORKER_VERSION,
            "reconstruction": {
                "engine": "nerfstudio",
                "method": "splatfacto",
                "iterations": int(iterations),
                "outputFormat": "ply",
            },
        },
    }
    if analysis:
        result["transform"] = {"matrix": analysis["matrix"], "matrixOrder": "column-major", "up": analysis["up"], "method": analysis["orientation"]["method"], "rotationApplied": analysis["orientation"]["rotationApplied"]}
        result["processing"]["orientation"] = analysis["orientation"]
    if crop is not None:
        result["processing"]["floaterCrop"] = crop
    if provenance:
        result["provenance"] = provenance
    return result
