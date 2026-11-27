"""A browser source set (still photos plus any number of clips) to a masked, posed Nerfstudio dataset.

The managed requester Node runs this stage on its own worker before anything leaves it: photos are decoded with their
EXIF orientation baked in, each clip is reduced to its sharpest distinct frames, faces are masked in every image, and
COLMAP solves the poses. Only the resulting dataset (masked images, `transforms.json`, `sparse_pc.ply`) is sent to a
remote provider, which trains it in the `prepared` input mode.

Layout of the source set:

    photos/<name>.jpg|.jpeg|.png    zero or more photographs
    videos/<name>.mp4|.mov          zero or more clips

The result names every input (`photos/<name>`, `videos/<name>`) with how many of its views were usable and, if none
were, a reason code, so the artist can see what to reshoot.
"""
from __future__ import annotations

import json
import pathlib
import shutil
from typing import Any, Callable

from photo_pipeline import (
    MAX_PHOTOS,
    _registered_names,
    default_convert,
    find_photos,
    prepare_photo,
    run_pose_solving,
)
from video_pipeline import VIDEO_EXTENSIONS, Progress, Runner, WorkerError, colmap_version, select_video_frames

MAX_CLIPS = 16
SET_SCHEMA = "kubus.prepared-dataset/1"


def find_clips(capture: pathlib.Path) -> list:
    directory = capture / "videos"
    if not directory.is_dir():
        return []
    root = directory.resolve()
    return sorted(
        path for path in directory.iterdir()
        if not path.is_symlink() and path.is_file() and path.resolve().parent == root
        and path.suffix.lstrip(".").lower() in VIDEO_EXTENSIONS
    )


def _input_feedback(inputs: list, registered: set | None) -> list:
    out = []
    for item in inputs:
        names = item["names"]
        usable = len(names) if registered is None else sum(1 for name in names if name in registered)
        reason = item.get("reason")
        if not reason and usable == 0:
            reason = "not_registered" if registered is not None else "no_usable_views"
        out.append({"input": item["input"], "kind": item["kind"], "submittedViews": len(names),
                    "usableViews": usable, "usable": usable > 0, "reason": reason if usable == 0 else None})
    return out


def prepare_source_set(
    runner: Runner,
    capture: pathlib.Path,
    work: pathlib.Path,
    progress: Progress,
    masker: Any = None,
    convert: Callable[[pathlib.Path, pathlib.Path], int] = default_convert,
    mask: bool = True,
) -> dict:
    """Returns the dataset directory, per-input feedback, the pose-solving summary and the pipelines' `masking` record.

    A clip that cannot be read, is too short or too blurry is reported as unusable and the rest of the set goes on;
    only a set with nothing usable left, or one COLMAP cannot pose well enough, fails. A pose-solving failure carries
    the per-input feedback in its details.
    """
    photos = find_photos(capture)
    clips = find_clips(capture)
    if not photos and not clips:
        raise WorkerError("no_usable_inputs", "The source set holds no photos and no clips")
    if len(photos) > MAX_PHOTOS or len(clips) > MAX_CLIPS:
        raise WorkerError("photos_unreadable", f"The source set holds {len(photos)} photos and {len(clips)} clips; "
                          f"the limits are {MAX_PHOTOS} and {MAX_CLIPS}", details={"submittedPhotos": len(photos)})
    dataset = work / "dataset"
    images = dataset / "images"
    shutil.rmtree(dataset, ignore_errors=True)
    images.mkdir(parents=True)
    if mask and masker is None:
        from face_mask import FaceMasker

        masker = FaceMasker()  # raises FaceMaskingError when the pinned weights are missing or altered
    from face_mask import FaceMaskingError, mask_frame_sequence

    inputs: list = []
    groups: list = []
    photo_names: list = []
    photo_regions: list = []
    photo_review: list = []
    photo_positions: list = []
    if photos:
        progress("preparing_photos", {"photos": {"submitted": len(photos)}})
        if mask:
            progress("masking_faces", {"images": len(photos)})
        for position, path in enumerate(photos, start=1):
            name = f"photo_{position - 1:05d}.jpg"
            entry = {"input": f"photos/{path.name}", "kind": "photo", "names": []}
            inputs.append(entry)
            try:
                facts = prepare_photo(path, images / name, masker=masker if mask else None)
            except FaceMaskingError:
                (images / name).unlink(missing_ok=True)
                raise
            except Exception:  # decoder errors come in many types
                (images / name).unlink(missing_ok=True)
                entry["reason"] = "unreadable"
                continue
            entry["names"].append(name)
            photo_names.append(name)
            photo_regions.append(facts["maskedRegions"])
            photo_review.append(facts["maskReview"])
            photo_positions.append(position)
        if photo_names:
            groups.append((photo_names, False))

    video_names: list = []
    video_regions: list = []
    video_review: list = []
    video_seconds: list = []
    for index, clip in enumerate(clips):
        entry = {"input": f"videos/{clip.name}", "kind": "clip", "names": []}
        inputs.append(entry)
        staging = work / f"clip_{index:02d}"
        shutil.rmtree(staging, ignore_errors=True)
        seconds: list = []
        try:
            names, _info, _selection = select_video_frames(
                runner, capture, work, progress, destination=staging, prefix=f"clip{index:02d}",
                seconds=seconds, masking_requested=mask, video=clip,
            )
        except WorkerError as error:
            if error.code == "raw_frames_not_removed":
                raise
            entry["reason"] = error.code
            shutil.rmtree(staging, ignore_errors=True)
            continue
        if mask:
            progress("masking_faces", {"images": len(names)})
            regions = mask_frame_sequence(masker, staging, names, review=(clip_review := []))
        else:
            regions, clip_review = None, []
        clip_names = []
        for position, name in enumerate(names):
            target = f"video_{len(video_names):05d}.jpg"
            shutil.move(str(staging / name), str(images / target))
            video_names.append(target)
            clip_names.append(target)
            video_seconds.append(seconds[position] if position < len(seconds) else None)
            if regions is not None:
                video_regions.append(regions[position])
                video_review.append(clip_review[position] if position < len(clip_review) else None)
        shutil.rmtree(staging, ignore_errors=True)
        entry["names"] = clip_names
        if clip_names:
            # Each clip is one camera; frames of different clips may come from different phones or zoom levels.
            groups.append((clip_names, True))

    submitted = len(photo_names) + len(video_names)
    if submitted == 0:
        raise WorkerError("no_usable_inputs", "None of the photos or clips produced a usable view",
                          details={"submittedViews": 0, "inputs": _input_feedback(inputs, None)})
    progress("solving_poses", {"views": submitted})
    try:
        sfm = run_pose_solving(runner, dataset, groups, submitted, convert)
    except WorkerError as error:
        error.details["inputs"] = _input_feedback(inputs, None)
        raise
    sfm["tool"] = "colmap"
    sfm["toolVersion"] = colmap_version(runner)
    registered = set(_registered_names(dataset / "transforms.json"))
    feedback = _input_feedback(inputs, registered)
    masking = {
        "photos": photo_regions if mask and photo_names else None,
        "photosReview": photo_review if mask and photo_names else None,
        "photosPositions": photo_positions if mask and photo_names else None,
        "photosFiles": [f"dataset/images/{name}" for name in photo_names] if mask and photo_names else None,
        "video": video_regions if mask and video_names else None,
        "videoReview": video_review if mask and video_names else None,
        "videoFiles": [f"dataset/images/{name}" for name in video_names] if mask and video_names else None,
        "videoSeconds": video_seconds if mask and video_names else None,
        "version": masker.version if mask and masker else None,
    }
    return {"dataset": dataset, "inputs": feedback, "sfm": sfm, "masking": masking}


def write_prepared_record(dataset: pathlib.Path, record: dict) -> None:
    """`prepared.json` travels with the dataset so the provider's manifest says how its images were prepared."""
    (dataset / "prepared.json").write_text(json.dumps({"schema": SET_SCHEMA, **record}, sort_keys=True), encoding="utf-8")


def read_prepared_record(dataset: pathlib.Path) -> dict:
    try:
        record = json.loads((dataset / "prepared.json").read_text(encoding="utf-8"))
    except (OSError, ValueError):
        raise WorkerError("prepared_dataset_invalid", "The prepared dataset has no readable prepared.json")
    if not isinstance(record, dict) or record.get("schema") != SET_SCHEMA:
        raise WorkerError("prepared_dataset_invalid", "The prepared dataset record has an unknown schema")
    return record
