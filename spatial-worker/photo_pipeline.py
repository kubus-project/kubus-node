"""Photo-set intake for the spatial worker.

A set of plain photographs has no camera poses and no intrinsics (no ARCore),
and unlike a video it usually mixes cameras, lenses and crops. This module
turns one, or a photo set plus one video (a "mixed" capture), into the same
Nerfstudio dataset the video path produces (`images/` + `transforms.json` +
`sparse_pc.ply`), using the same COLMAP structure-from-motion and the same
registered-view floor and registration-ratio gate:

1. every photo is decoded, its EXIF orientation baked into the pixels (COLMAP
   and Nerfstudio ignore the tag), downscaled and re-encoded under a constant
   name with only the lens facts COLMAP uses as a focal-length prior,
2. for a mixed capture the video goes through the existing frame selection
   (`video_pipeline.select_video_frames`) into the same image folder,
3. COLMAP runs in stages (feature extraction, exhaustive matching, mapper).
   `ns-process-data images` assumes one camera for the whole folder; photos from
   several devices and crops need several, so the stages are run directly and
   Nerfstudio's own `colmap_to_json` converts the result. Photos get one
   camera per distinct (size, lens) as COLMAP groups them; video frames share
   one camera.
4. the largest reconstructed model is chosen, and the gate decides whether it
   is worth a GPU training run (`sfm_failed` otherwise).

Every external tool runs through the injected `runner(command, timeout)` so the
job's cancellation machinery owns the processes and tests can substitute fakes.
"""
import json
import pathlib
import re
import shutil
import struct
from typing import Any, Callable

from face_mask import FaceMaskingError, FaceMasker, to_srgb
from video_pipeline import (
    MIN_REGISTRATION_RATIO,
    MIN_VIEWS_FOR_RECONSTRUCTION,
    WorkerError,
    check_registration_gates,
    colmap_version,
    count_registered_views,
    select_video_frames,
    _bounded_env,
    _float_env,
    _tail,
)

PHOTO_EXTENSIONS = ("jpg", "jpeg", "png")
# The Node refuses fewer than 8 at import; the worker repeats the bound for packages that skipped the Node.
MIN_PHOTOS = int(_float_env("KUBUS_PHOTO_MIN_COUNT", 8))
MAX_PHOTOS = 400
MAX_PHOTO_PIXELS = 200_000_000
PHOTO_MAX_LONG_SIDE = int(_float_env("KUBUS_PHOTO_MAX_LONG_SIDE", 2048))
# The photo gate defaults to the video gate; photo sets are small, so an operator may tune it separately.
PHOTO_MIN_REGISTERED_VIEWS = int(_bounded_env("KUBUS_PHOTO_MIN_REGISTERED_VIEWS", MIN_VIEWS_FOR_RECONSTRUCTION, 3, 100_000))
PHOTO_MIN_REGISTRATION_RATIO = _bounded_env("KUBUS_PHOTO_MIN_REGISTRATION_RATIO", MIN_REGISTRATION_RATIO, 0.0, 1.0)

# Pose solving as a whole is budgeted at 3 h by the Node (workerClient.WORKER_TOOL_TIMEOUTS_MS):
# 30 min + 45 min + 60 min = 2 h 15 min.
FEATURE_TIMEOUT = 30 * 60
MATCH_TIMEOUT = 45 * 60
MAPPER_TIMEOUT = 60 * 60

# EXIF tags kept as COLMAP's focal-length prior.
TAG_MAKE, TAG_MODEL, TAG_ORIENTATION, TAG_EXIF_IFD = 0x010F, 0x0110, 0x0112, 0x8769
TAG_FOCAL_LENGTH, TAG_FOCAL_LENGTH_35 = 0x920A, 0xA405

Runner = Callable[[list, float], Any]
Progress = Callable[[str, dict], None]


def natural_key(path: pathlib.Path) -> list:
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", path.name)]


def find_photos(capture: pathlib.Path) -> list:
    """Regular image files directly under `photos/`, in natural name order. Links and subfolders are ignored."""
    directory = capture / "photos"
    if not directory.is_dir():
        return []
    root = directory.resolve()
    found = []
    for path in directory.iterdir():
        if path.is_symlink() or not path.is_file() or path.suffix.lstrip(".").lower() not in PHOTO_EXTENSIONS:
            continue
        if path.resolve().parent != root:
            continue
        found.append(path)
    return sorted(found, key=natural_key)


def _text(value: Any) -> str:
    return str(value).strip().strip("\x00")[:60] if value is not None else ""


def prepare_photo(source: pathlib.Path, target: pathlib.Path, max_long_side: int = PHOTO_MAX_LONG_SIDE, masker: FaceMasker | None = None) -> dict:
    """Decode `source`, bake its EXIF orientation, mask faces when asked to, downscale, and write a clean JPEG to `target`.

    Masking runs on the full-resolution upright pixels, before the downscale, so no unmasked pixel is ever
    written to the job's image folder. A masking failure is an error, never a skipped image.
    """
    from PIL import Image, ImageOps  # present in the worker image; imported lazily so the module imports anywhere

    Image.MAX_IMAGE_PIXELS = None  # Pillow only warns up to 2x its limit; the bound is enforced explicitly below
    with Image.open(source) as opened:
        if opened.size[0] * opened.size[1] > MAX_PHOTO_PIXELS:  # the header is read, nothing is decoded yet
            raise ValueError("photo exceeds the pixel limit")
        opened.load()  # a truncated or corrupt file fails here, not in COLMAP
        exif = opened.getexif()
        orientation = int(exif.get(TAG_ORIENTATION, 1) or 1)
        lens = exif.get_ifd(TAG_EXIF_IFD)
        make, model = _text(exif.get(TAG_MAKE)), _text(exif.get(TAG_MODEL))
        focal, focal35 = lens.get(TAG_FOCAL_LENGTH), lens.get(TAG_FOCAL_LENGTH_35)
        upright = ImageOps.exif_transpose(opened)  # orientation applied to the pixels
        icc = opened.info.get("icc_profile")
        image, _ = to_srgb(upright.convert("RGB"), icc)  # a Display P3 photo is read as sRGB by everything downstream
    regions = 0
    review: dict = {}
    if masker is not None:
        import numpy as np

        try:
            masked, regions = masker.mask_array(np.asarray(image), review=review)
        except Exception as error:
            raise FaceMaskingError("face masking failed on an image") from error
        image = Image.fromarray(masked)
    width, height = image.size
    factor = min(1.0, max_long_side / max(width, height))
    if factor < 1.0:
        image = image.resize((max(1, round(width * factor)), max(1, round(height * factor))), Image.LANCZOS)
    clean = Image.Exif()
    if make:
        clean[TAG_MAKE] = make
    if model:
        clean[TAG_MODEL] = model
    prior: dict = {}
    if focal is not None:
        prior[TAG_FOCAL_LENGTH] = focal
    if focal35:
        prior[TAG_FOCAL_LENGTH_35] = int(focal35)
    if prior:
        clean[TAG_EXIF_IFD] = prior  # assigned whole: Pillow drops a sub-IFD edited in place
    image.save(target, "JPEG", quality=95, exif=clean.tobytes())
    return {
        "width": image.size[0], "height": image.size[1],
        "sourceWidth": width, "sourceHeight": height,
        "orientationApplied": orientation != 1,
        "maskedRegions": regions,
        "maskReview": review,
        "camera": " ".join(part for part in (make, model) if part) or "unknown",
    }


def prepare_photos(paths: list, destination: pathlib.Path, prefix: str = "photo", masker: FaceMasker | None = None) -> tuple:
    """Prepare every photo; returns (names written, statistics). Unreadable files are dropped and counted.

    With a `masker`, the statistics carry `maskedRegions` (the region count of each written photo, in order) and
    `maskedReview` (what a human has to look at in each, see `face_mask.FaceMasker.find_regions`) and
    `maskedPositions` (each written photo's number among the submitted ones).
    """
    destination.mkdir(parents=True, exist_ok=True)
    names: list = []
    cameras: dict = {}
    rotated = 0
    unreadable = 0
    regions: list = []
    reviews: list = []
    positions: list = []
    for position, path in enumerate(paths, start=1):
        name = f"{prefix}_{len(names):05d}.jpg"
        try:
            facts = prepare_photo(path, destination / name, masker=masker)
        except FaceMaskingError:
            (destination / name).unlink(missing_ok=True)
            raise
        except Exception:  # decoder errors are many types (OSError, ValueError, DecompressionBombError)
            unreadable += 1
            (destination / name).unlink(missing_ok=True)
            continue
        names.append(name)
        regions.append(facts["maskedRegions"])
        reviews.append(facts["maskReview"])
        positions.append(position)  # the photo's number in the capture (photos/00001.jpg is 1), kept when others are dropped
        rotated += 1 if facts["orientationApplied"] else 0
        cameras[facts["camera"]] = cameras.get(facts["camera"], 0) + 1
    stats = {
        "submitted": len(paths), "usable": len(names), "unreadable": unreadable,
        "orientationApplied": rotated, "cameras": cameras, "maxLongSide": PHOTO_MAX_LONG_SIDE,
    }
    if masker is not None:
        stats["maskedRegions"] = regions
        stats["maskedReview"] = reviews
        stats["maskedPositions"] = positions
    return names, stats


def _first_uint64(path: pathlib.Path) -> int:
    try:
        with path.open("rb") as handle:
            return struct.unpack("<Q", handle.read(8))[0]
    except (OSError, struct.error):
        return 0


def registered_in_model(model: pathlib.Path) -> int:
    """Registered images in a COLMAP binary model (`images.bin` starts with the count)."""
    return _first_uint64(model / "images.bin")


def cameras_in_model(model: pathlib.Path) -> int:
    return _first_uint64(model / "cameras.bin")


def default_convert(model: pathlib.Path, dataset: pathlib.Path) -> int:
    """Nerfstudio's own COLMAP-to-transforms.json conversion (also writes `sparse_pc.ply`)."""
    from nerfstudio.process_data.colmap_utils import colmap_to_json  # lazy: heavy, worker image only

    return colmap_to_json(recon_dir=model, output_dir=dataset)


def run_pose_solving(
    runner: Runner,
    dataset: pathlib.Path,
    groups: list,
    submitted: int,
    convert: Callable[[pathlib.Path, pathlib.Path], int] = default_convert,
) -> dict:
    """COLMAP over `dataset/images`, gated. `groups` is [(image names, one shared camera?)]."""
    images = dataset / "images"
    colmap_dir = dataset / "colmap"
    sparse = colmap_dir / "sparse"
    database = colmap_dir / "database.db"
    shutil.rmtree(colmap_dir, ignore_errors=True)
    sparse.mkdir(parents=True)

    def stage(name: str, command: list, timeout: float) -> None:
        completed = runner(command, timeout)
        if completed.returncode != 0:
            raise WorkerError(
                "sfm_failed",
                f"COLMAP {name} failed; the images could not be matched",
                details={"submittedViews": submitted, "stage": name, "tail": _tail(completed)},
            )

    for index, (names, single_camera) in enumerate(groups):
        listing = colmap_dir / f"images_{index}.txt"
        listing.write_text("\n".join(names) + "\n", encoding="utf-8")
        stage("feature extraction", [
            "colmap", "feature_extractor", "--database_path", str(database), "--image_path", str(images),
            "--image_list_path", str(listing), "--ImageReader.camera_model", "SIMPLE_RADIAL",
            "--ImageReader.single_camera", "1" if single_camera else "0",
            "--SiftExtraction.use_gpu", "1", "--SiftExtraction.max_image_size", "2048",
        ], FEATURE_TIMEOUT)
    stage("matching", ["colmap", "exhaustive_matcher", "--database_path", str(database), "--SiftMatching.use_gpu", "1"], MATCH_TIMEOUT)
    stage("mapping", [
        "colmap", "mapper", "--database_path", str(database), "--image_path", str(images), "--output_path", str(sparse),
        "--Mapper.ba_global_function_tolerance", "1e-6",
    ], MAPPER_TIMEOUT)

    models = sorted((entry for entry in sparse.iterdir() if entry.is_dir() and (entry / "images.bin").is_file()), key=lambda entry: entry.name)
    if not models:
        raise WorkerError(
            "sfm_failed",
            "COLMAP could not build any model from these images; they may not overlap enough or share too little texture",
            details={"submittedViews": submitted, "registeredViews": 0, "registrationRatio": 0.0},
        )
    best = max(models, key=registered_in_model)
    registered = registered_in_model(best)
    details = {"submittedViews": submitted, "registeredViews": registered, "registrationRatio": round(registered / submitted, 3) if submitted else 0.0,
               "modelsFound": len(models), "cameras": cameras_in_model(best)}
    check_registration_gates(registered, submitted, details, PHOTO_MIN_REGISTERED_VIEWS, PHOTO_MIN_REGISTRATION_RATIO, noun="images")
    convert(best, dataset)
    transforms = dataset / "transforms.json"
    if not transforms.is_file():
        raise WorkerError("sfm_failed", "COLMAP finished but no camera poses could be exported", details=details)
    details["registeredViews"] = count_registered_views(transforms)
    details["registrationRatio"] = round(details["registeredViews"] / submitted, 3) if submitted else 0.0
    names = _registered_names(transforms)
    details["registeredPhotos"] = sum(1 for name in names if name.startswith("photo_"))
    details["registeredVideoFrames"] = sum(1 for name in names if name.startswith("video_"))
    return details


def _registered_names(transforms: pathlib.Path) -> list:
    try:
        frames = json.loads(transforms.read_text(encoding="utf-8")).get("frames", [])
    except (OSError, ValueError):
        return []
    return [pathlib.PurePosixPath(frame.get("file_path", "")).name for frame in frames if isinstance(frame, dict)]


def prepare_photo_dataset(
    runner: Runner,
    capture: pathlib.Path,
    work: pathlib.Path,
    progress: Progress,
    include_video: bool = False,
    convert: Callable[[pathlib.Path, pathlib.Path], int] = default_convert,
    mask_photos: bool = False,
    mask_video: bool = False,
    masker: FaceMasker | None = None,
) -> dict:
    """Photos (and optionally the capture's video) to a posed Nerfstudio dataset. Returns dataset, facts and statistics.

    `mask_photos` / `mask_video` ask for faces to be masked in the photos / the video frames before pose solving.
    The result's `masking` holds the region counts per image and the detector's version.
    """
    paths = find_photos(capture)
    if len(paths) < MIN_PHOTOS:
        raise WorkerError(
            "photos_unreadable",
            f"The capture holds {len(paths)} photos; at least {MIN_PHOTOS} are needed",
            details={"submittedPhotos": len(paths)},
        )
    if len(paths) > MAX_PHOTOS:
        raise WorkerError("photos_unreadable", f"The capture holds {len(paths)} photos; the limit is {MAX_PHOTOS}", details={"submittedPhotos": len(paths)})
    dataset = work / "dataset"
    images = dataset / "images"
    shutil.rmtree(dataset, ignore_errors=True)
    if (mask_photos or mask_video) and masker is None:
        masker = FaceMasker()  # raises FaceMaskingError when the pinned weights are missing or altered
    if mask_photos:
        progress("masking_faces", {"images": len(paths)})
    progress("preparing_photos", {"photos": {"submitted": len(paths)}})
    names, photo_stats = prepare_photos(paths, images, "photo", masker=masker if mask_photos else None)
    if len(names) < MIN_PHOTOS:
        raise WorkerError(
            "photos_unreadable",
            f"Only {len(names)} of {len(paths)} photos could be decoded; at least {MIN_PHOTOS} are needed",
            details={"submittedPhotos": len(paths), "usablePhotos": len(names)},
        )
    groups = [(names, False)]
    video_info: dict | None = None
    frame_stats: dict | None = None
    video_regions: list | None = None
    video_review: list = []
    video_seconds: list = []
    if include_video:
        video_names, video_info, frame_stats = select_video_frames(runner, capture, work, progress, images, prefix="video", seconds=video_seconds)
        if mask_video:
            from face_mask import mask_frame_sequence

            progress("masking_faces", {"images": len(video_names)})
            video_regions = mask_frame_sequence(masker, images, video_names, review=video_review)
        groups.append((video_names, True))
    submitted = len(names) + (len(groups[1][0]) if include_video else 0)
    progress("solving_poses", {"frames": frame_stats or {}, "photos": {"submitted": len(names)}})
    sfm = run_pose_solving(runner, dataset, groups, submitted, convert)
    sfm["tool"] = "colmap"
    sfm["toolVersion"] = colmap_version(runner)
    sfm["submittedPhotos"] = len(names)
    try:
        has_points = bool(json.loads((dataset / "transforms.json").read_text(encoding="utf-8")).get("ply_file_path"))
    except (OSError, ValueError):
        has_points = False
    sfm["sparsePointsInitialisation"] = has_points and (dataset / "sparse_pc.ply").is_file()
    masking = {
        "photos": photo_stats.get("maskedRegions") if mask_photos else None, "photosReview": photo_stats.get("maskedReview") if mask_photos else None,
        "photosPositions": photo_stats.get("maskedPositions") if mask_photos else None,
        # Each flagged image's path under the job's output directory, for the operator's look (see `face_mask.needs_look`).
        "photosFiles": [f"dataset/images/{name}" for name in names] if mask_photos else None,
        "videoFiles": [f"dataset/images/{name}" for name in video_names] if video_regions is not None else None,
        "videoSeconds": video_seconds if video_regions is not None else None,
        "video": video_regions, "videoReview": video_review if video_regions is not None else None,
        "version": masker.version if masker else None,
    }
    return {"dataset": dataset, "photos": photo_stats, "video": video_info, "frames": frame_stats, "sfm": sfm, "masking": masking}
