"""Native video intake for the spatial worker.

A video has no camera poses and no intrinsics. This module turns one into a
Nerfstudio dataset (`images/` + `transforms.json` + `sparse_pc.ply`) that
`ns-train splatfacto` can read directly:

1. `ffprobe` decides whether the file is a usable video at all.
2. `ffmpeg` extracts an *oversampled* set of frames.
3. Frames are scored (variance of the Laplacian), blurry frames and
   near-duplicates are dropped, and the sharpest frame per time bucket is kept.
4. `ns-process-data images` runs COLMAP structure-from-motion over the kept
   frames. (`ns-process-data video` is the same COLMAP step preceded by a
   uniform ffmpeg extraction; running the images subcommand is what lets the
   blur and duplicate filter sit in front of COLMAP.) COLMAP's sparse points are
   written as `sparse_pc.ply` and referenced from `transforms.json`, which
   splatfacto uses to initialise its Gaussians.
5. The registered-view floor and registration-ratio gate decide whether the
   reconstruction is worth a GPU training run.

Every external tool runs through an injected `runner(command, timeout)` so the
job's cancellation machinery (`JobControl.run`) owns the processes, and so tests
can substitute fakes. Nothing here imports torch or FastAPI.
"""
import json
import os
import pathlib
import shutil
from typing import Any, Callable

# The same floor the Node adapter enforces for pose captures
# (`MIN_VIEWS_FOR_RECONSTRUCTION`).
MIN_VIEWS_FOR_RECONSTRUCTION = 24

VIDEO_EXTENSIONS = ("mp4", "mov", "m4v", "webm", "mkv")


def _float_env(name: str, default: float) -> float:
    try:
        return float(os.environ.get(name, default))
    except ValueError:
        return default


MIN_DURATION_SECONDS = _float_env("KUBUS_VIDEO_MIN_SECONDS", 3.0)
MAX_DURATION_SECONDS = _float_env("KUBUS_VIDEO_MAX_SECONDS", 20 * 60.0)
# Fraction of submitted frames COLMAP must register for the run to proceed.
MIN_REGISTRATION_RATIO = _float_env("KUBUS_VIDEO_MIN_REGISTRATION_RATIO", 0.6)
# A frame is "blurry" when it scores below this fraction of the median score.
BLUR_RATIO = _float_env("KUBUS_VIDEO_BLUR_RATIO", 0.5)
# Median sharpness below this means the whole clip is soft, not just some frames.
MIN_MEDIAN_SHARPNESS = _float_env("KUBUS_VIDEO_MIN_MEDIAN_SHARPNESS", 3.0)
# Mean absolute difference (0-255) between 32x32 thumbnails below which two
# consecutive frames are the same view.
DUPLICATE_DIFF = _float_env("KUBUS_VIDEO_DUPLICATE_DIFF", 1.5)
OVERSAMPLE_FACTOR = _float_env("KUBUS_VIDEO_OVERSAMPLE", 2.5)
MAX_LONG_SIDE = int(_float_env("KUBUS_VIDEO_MAX_LONG_SIDE", 1920))
FRAMES_PER_SECOND_TARGET = _float_env("KUBUS_VIDEO_FRAMES_PER_SECOND", 3.0)
MIN_TARGET_FRAMES = int(_float_env("KUBUS_VIDEO_MIN_TARGET_FRAMES", 48))
MAX_TARGET_FRAMES = int(_float_env("KUBUS_VIDEO_MAX_TARGET_FRAMES", 240))
MAX_EXTRACTED_FRAMES = 800

Runner = Callable[[list, float], Any]
Progress = Callable[[str, dict], None]


class WorkerError(Exception):
    """A typed failure the operator should see, with a stable machine code."""

    def __init__(self, code: str, message: str, status: int = 422, details: dict | None = None):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status = status
        self.details = details or {}

    def detail(self) -> dict:
        return {"code": self.code, "message": self.message, "details": self.details}


def find_source_video(capture: pathlib.Path) -> pathlib.Path:
    directory = capture / "video"
    candidates = sorted(
        path for path in directory.glob("source.*")
        if path.is_file() and path.suffix.lstrip(".").lower() in VIDEO_EXTENSIONS
    ) if directory.is_dir() else []
    if not candidates:
        raise WorkerError("video_unreadable", "The capture contains no video/source.* file")
    if len(candidates) > 1:
        raise WorkerError("video_unreadable", "The capture contains more than one video")
    return candidates[0]


def _tail(completed: Any, limit: int = 600) -> str:
    text = (getattr(completed, "stderr", "") or getattr(completed, "stdout", "") or "").strip()
    return text[-limit:]


def probe_video(runner: Runner, video: pathlib.Path) -> dict:
    """Return duration, geometry and frame-rate facts, or raise a typed error."""
    completed = runner([
        "ffprobe", "-v", "error", "-print_format", "json", "-show_format", "-show_streams", str(video),
    ], 120)
    if completed.returncode != 0:
        raise WorkerError("video_unreadable", "ffprobe could not read the video", details={"tail": _tail(completed)})
    try:
        document = json.loads(completed.stdout or "{}")
    except json.JSONDecodeError:
        raise WorkerError("video_unreadable", "ffprobe returned unreadable output")
    streams = [s for s in document.get("streams", []) if s.get("codec_type") == "video"
               and s.get("disposition", {}).get("attached_pic", 0) != 1]
    if not streams:
        raise WorkerError("video_unreadable", "The file has no video stream")
    stream = streams[0]
    width = int(stream.get("width") or 0)
    height = int(stream.get("height") or 0)
    if width <= 0 or height <= 0:
        raise WorkerError("video_unreadable", "The video stream has no frame size")
    try:
        duration = float(stream.get("duration") or document.get("format", {}).get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    if duration <= 0:
        raise WorkerError("video_unreadable", "The video has no readable duration")
    if duration < MIN_DURATION_SECONDS:
        raise WorkerError(
            "video_too_short",
            f"The video is {duration:.1f} s; at least {MIN_DURATION_SECONDS:.0f} s of orbit footage is required",
            details={"durationSeconds": round(duration, 2), "minSeconds": MIN_DURATION_SECONDS},
        )
    if duration > MAX_DURATION_SECONDS:
        raise WorkerError(
            "video_unreadable",
            f"The video is {duration:.0f} s; the limit is {MAX_DURATION_SECONDS:.0f} s",
            details={"durationSeconds": round(duration, 2), "maxSeconds": MAX_DURATION_SECONDS},
        )
    rate = 0.0
    try:
        numerator, denominator = str(stream.get("avg_frame_rate", "0/1")).split("/")
        rate = float(numerator) / float(denominator) if float(denominator) else 0.0
    except (ValueError, ZeroDivisionError):
        rate = 0.0
    return {
        "durationSeconds": round(duration, 3),
        "width": width,
        "height": height,
        "frameRate": round(rate, 3),
        "codec": stream.get("codec_name"),
    }


def plan_frames(duration: float) -> tuple:
    """(final target, oversampled extraction count) for a clip of `duration` seconds."""
    target = max(MIN_TARGET_FRAMES, min(MAX_TARGET_FRAMES, int(duration * FRAMES_PER_SECOND_TARGET)))
    extract = min(MAX_EXTRACTED_FRAMES, int(target * OVERSAMPLE_FACTOR))
    return target, extract


def extract_frames(runner: Runner, video: pathlib.Path, destination: pathlib.Path, count: int, duration: float, source_fps: float = 0.0) -> list:
    destination.mkdir(parents=True, exist_ok=True)
    rate = max(0.05, count / duration)
    # Never sample faster than the footage: the fps filter would repeat frames.
    if source_fps > 0:
        rate = min(rate, source_fps)
    scale = (
        f"scale=w='if(gt(iw,ih),min(iw,{MAX_LONG_SIDE}),-2)':h='if(gt(iw,ih),-2,min(ih,{MAX_LONG_SIDE}))'"
    )
    completed = runner([
        "ffmpeg", "-y", "-v", "error", "-i", str(video), "-an", "-sn",
        "-vf", f"fps={rate:.6f},{scale}", "-qscale:v", "2", "-start_number", "0",
        str(destination / "%05d.jpg"),
    ], 60 * 60)
    frames = sorted(destination.glob("*.jpg"))
    if completed.returncode != 0 and not frames:
        raise WorkerError("video_unreadable", "ffmpeg could not decode the video", details={"tail": _tail(completed)})
    return frames


def score_frames(paths: list) -> list:
    """Per-frame sharpness (variance of the Laplacian at a fixed width) and a tiny thumbnail."""
    import cv2  # imported lazily: present in the worker image, not needed to import this module
    import numpy as np

    scored = []
    for path in paths:
        image = cv2.imread(str(path), cv2.IMREAD_GRAYSCALE)
        if image is None:
            continue
        height, width = image.shape[:2]
        long_side = max(height, width)
        if long_side > 640:
            factor = 640.0 / long_side
            image = cv2.resize(image, (max(1, int(width * factor)), max(1, int(height * factor))), interpolation=cv2.INTER_AREA)
        sharpness = float(cv2.Laplacian(image, cv2.CV_64F).var())
        thumb = cv2.resize(image, (32, 32), interpolation=cv2.INTER_AREA).astype(np.float32)
        scored.append({"path": path, "sharpness": sharpness, "thumb": thumb})
    return scored


def select_frames(scored: list, target: int) -> tuple:
    """Drop blurry and near-duplicate frames, then keep the sharpest frame per time bucket."""
    import numpy as np

    stats: dict = {"extracted": len(scored)}
    if len(scored) < MIN_VIEWS_FOR_RECONSTRUCTION:
        raise WorkerError(
            "video_too_short",
            f"Only {len(scored)} frames could be extracted; at least {MIN_VIEWS_FOR_RECONSTRUCTION} are needed",
            details=stats,
        )
    scores = sorted(item["sharpness"] for item in scored)
    median = scores[len(scores) // 2]
    stats["medianSharpness"] = round(median, 2)
    if median < MIN_MEDIAN_SHARPNESS:
        raise WorkerError(
            "frames_too_blurry",
            "The footage is too soft overall to reconstruct; film slower, in better light, with the subject in focus",
            details=stats,
        )
    threshold = BLUR_RATIO * median
    sharp = [item for item in scored if item["sharpness"] >= threshold]
    stats["blurDropped"] = len(scored) - len(sharp)

    kept: list = []
    duplicates = 0
    for item in sharp:
        if kept:
            difference = float(np.mean(np.abs(item["thumb"] - kept[-1]["thumb"])))
            if difference < DUPLICATE_DIFF:
                duplicates += 1
                if item["sharpness"] > kept[-1]["sharpness"]:
                    kept[-1] = item
                continue
        kept.append(item)
    stats["duplicateDropped"] = duplicates

    if len(kept) > target:
        buckets: list = [[] for _ in range(target)]
        for index, item in enumerate(kept):
            buckets[min(target - 1, index * target // len(kept))].append(item)
        kept = [max(bucket, key=lambda entry: entry["sharpness"]) for bucket in buckets if bucket]
    stats["selected"] = len(kept)
    if len(kept) < MIN_VIEWS_FOR_RECONSTRUCTION:
        code = "frames_too_blurry" if stats["blurDropped"] >= stats["duplicateDropped"] else "video_too_short"
        raise WorkerError(
            code,
            f"Only {len(kept)} usable frames remain after dropping blurry and near-duplicate frames; "
            f"at least {MIN_VIEWS_FOR_RECONSTRUCTION} are needed",
            details=stats,
        )
    return kept, stats


def count_registered_views(transforms: pathlib.Path) -> int:
    try:
        document = json.loads(transforms.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return 0
    frames = document.get("frames")
    return len(frames) if isinstance(frames, list) else 0


def colmap_version(runner: Runner) -> str | None:
    try:
        completed = runner(["colmap", "-h"], 60)
    except Exception:
        return None
    first = (getattr(completed, "stdout", "") or "").strip().splitlines()
    return first[0].strip() if first else None


def check_registration_gates(
    registered: int,
    submitted: int,
    details: dict,
    min_views: int = MIN_VIEWS_FOR_RECONSTRUCTION,
    min_ratio: float = MIN_REGISTRATION_RATIO,
    noun: str = "frames",
) -> None:
    """The registered-view floor and registration-ratio gate shared by every COLMAP-based intake."""
    ratio = registered / submitted if submitted else 0.0
    if registered < min_views:
        raise WorkerError(
            "sfm_failed",
            f"COLMAP registered only {registered} of {submitted} {noun}; at least {min_views} are needed",
            details=details,
        )
    if ratio < min_ratio:
        raise WorkerError(
            "sfm_failed",
            f"COLMAP registered {registered} of {submitted} {noun} ({ratio:.0%}); at least {min_ratio:.0%} are needed",
            details=details,
        )


def run_structure_from_motion(runner: Runner, frames_directory: pathlib.Path, dataset: pathlib.Path, submitted: int) -> dict:
    dataset.mkdir(parents=True, exist_ok=True)
    completed = runner([
        "ns-process-data", "images",
        "--data", str(frames_directory), "--output-dir", str(dataset),
        "--camera-type", "perspective", "--sfm-tool", "colmap", "--matching-method", "exhaustive",
        "--num-downscales", "2", "--gpu",
    ], 3 * 60 * 60)
    transforms = dataset / "transforms.json"
    if completed.returncode != 0 or not transforms.is_file():
        raise WorkerError(
            "sfm_failed",
            "COLMAP could not recover camera poses from the footage; orbit the subject with steady, overlapping views",
            details={"submittedViews": submitted, "tail": _tail(completed)},
        )
    registered = count_registered_views(transforms)
    ratio = registered / submitted if submitted else 0.0
    details = {"submittedViews": submitted, "registeredViews": registered, "registrationRatio": round(ratio, 3)}
    check_registration_gates(registered, submitted, details)
    try:
        has_points = bool(json.loads(transforms.read_text(encoding="utf-8")).get("ply_file_path"))
    except (OSError, json.JSONDecodeError):
        has_points = False
    details["sparsePointsInitialisation"] = has_points and (dataset / "sparse_pc.ply").is_file()
    return details


def select_video_frames(
    runner: Runner,
    capture: pathlib.Path,
    work: pathlib.Path,
    progress: Progress,
    destination: pathlib.Path | None = None,
    prefix: str = "frame",
) -> tuple:
    """Probe the capture's video, extract, filter and select frames into `destination`.

    Returns (file names written, video facts, selection statistics). Shared by the
    video intake and the mixed photo + video intake.
    """
    video = find_source_video(capture)
    info = probe_video(runner, video)
    target, extract_count = plan_frames(info["durationSeconds"])
    raw = work / "raw_frames"
    progress("extracting_frames", {"video": info, "targetFrames": target, "extractFrames": extract_count})
    paths = extract_frames(runner, video, raw, extract_count, info["durationSeconds"], info["frameRate"])
    selected, selection = select_frames(score_frames(paths), target)
    chosen = destination if destination is not None else work / "selected_frames"
    if destination is None and chosen.exists():
        shutil.rmtree(chosen)
    chosen.mkdir(parents=True, exist_ok=True)
    names = []
    for index, item in enumerate(selected):
        name = f"{prefix}_{index:05d}.jpg"
        shutil.copyfile(item["path"], chosen / name)
        names.append(name)
    shutil.rmtree(raw, ignore_errors=True)
    return names, info, selection


def prepare_video_dataset(runner: Runner, capture: pathlib.Path, work: pathlib.Path, progress: Progress) -> dict:
    """Run the whole video-to-dataset stage. Returns the dataset directory and a statistics summary."""
    names, info, selection = select_video_frames(runner, capture, work, progress)
    chosen = work / "selected_frames"
    progress("solving_poses", {"frames": selection})
    dataset = work / "dataset"
    sfm = run_structure_from_motion(runner, chosen, dataset, len(names))
    sfm["tool"] = "colmap"
    sfm["toolVersion"] = colmap_version(runner)
    return {"dataset": dataset, "video": info, "frames": selection, "sfm": sfm}
