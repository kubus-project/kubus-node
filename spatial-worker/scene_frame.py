"""Viewer orientation and floater crop for a COLMAP-solved scene.

COLMAP and Nerfstudio know nothing about gravity: the solved scene has an
arbitrary orientation, centre and scale. A viewer that assumes "+Y is up, the
subject is near the origin, the camera looks at it from +Z" therefore opens it
sideways, off-centre or from behind. This module turns the solved cameras and
sparse points into

* an up vector (the mean of the cameras' up axes; if the cameras disagree, the
  normal of the dominant plane of the sparse points, signed by the cameras. That
  fallback is a heuristic: it assumes the plane is horizontal, so it is reported
  with a confidence below the trusted level and `trusted: false`; an answer that
  is not trusted is never used to rotate the scene, see `analyse_scene`),
* a front direction (where the cameras stand relative to the subject, when they
  cover one side rather than a full orbit),
* a bounding box of the subject (percentile box of the sparse points) used to
  crop stray Gaussians (floaters) at export, and
* a 4x4 viewer transform (column-major, three.js order) that puts the subject
  upright, centred, scaled to a radius of about 1 and facing +Z. When the up
  estimate is not trusted the transform only centres and scales: guessing a
  rotation could open a mural sideways, and an unrotated splat is at worst
  tilted the way the reconstruction came out.

Everything is expressed in the coordinate frame of the *exported splat file*
(`ns-export` writes the trained Gaussian centres unchanged, so that is the
Nerfstudio dataparser frame). `transforms.json` is in a different frame: it
already has `applied_transform` baked in, while `dataparser_transforms.json`
(`transform` 3x4 and `scale`) maps the *raw COLMAP* world to the training
frame, with `applied_transform` folded in. Cameras and points are therefore
mapped as `T_dataparser @ inverse(applied_transform)` before anything is
estimated. Pure numpy; nothing here imports torch or nerfstudio.
"""
import json
import math
import pathlib
from typing import Any

import numpy as np

# Below this mean-resultant length the cameras' "up" axes do not agree
# (rotated or mixed-orientation photos), so the plane fallback is used.
MIN_UP_CONFIDENCE = 0.6
# The plane fallback is only trusted when the cameras look at the plane obliquely: above this mean
# |cos| between their viewing directions and the plane normal they are face-on (a wall or a top-down floor).
MAX_PLANE_FACE_ON = 0.8
# The plane-normal fallback is a heuristic: it assumes the dominant plane of the sparse points is horizontal (a
# floor or table). View geometry alone cannot tell that from a wall photographed obliquely with rolled cameras, so
# its confidence never reaches MIN_UP_CONFIDENCE and the orientation record marks it as not trusted.
PLANE_FALLBACK_MAX_CONFIDENCE = 0.5
# Below this the cameras surround the subject (a full orbit), so no front exists.
MIN_FRONT_CONFIDENCE = 0.4
# Subject box from this percentile range of the sparse points, per axis.
CROP_PERCENTILES = (2.0, 98.0)
# The box is grown by this fraction of its own extent on each side, but never by less
# than MIN_MARGIN_OF_LARGEST_EXTENT of the largest side (a flat subject has a tiny extent).
CROP_MARGIN = 0.35
MIN_MARGIN_OF_LARGEST_EXTENT = 0.15
# The subject's largest dimension is mapped to this many viewer units (radius 1 = 2 units across).
VIEWER_RADIUS = 1.0


def read_ascii_ply_points(path: pathlib.Path) -> np.ndarray:
    """Positions from an ASCII PLY such as Nerfstudio's `sparse_pc.ply` (x y z r g b)."""
    with path.open("r", encoding="utf-8") as handle:
        count = None
        for line in handle:
            line = line.strip()
            if line.startswith("element vertex"):
                count = int(line.split()[2])
            if line == "end_header":
                break
        if count is None:
            raise ValueError("ply has no vertex element")
        rows = []
        for _ in range(count):
            parts = handle.readline().split()
            if len(parts) >= 3:
                rows.append([float(parts[0]), float(parts[1]), float(parts[2])])
    return np.asarray(rows, dtype=np.float64).reshape(-1, 3)


def load_camera_poses(transforms: pathlib.Path) -> np.ndarray:
    """Camera-to-world matrices (N, 4, 4), OpenGL convention, from a Nerfstudio `transforms.json`."""
    document = json.loads(transforms.read_text(encoding="utf-8"))
    matrices = [np.asarray(frame["transform_matrix"], dtype=np.float64) for frame in document.get("frames", [])]
    if not matrices:
        raise ValueError("transforms.json has no frames")
    return np.stack(matrices)


def load_dataparser_transform(path: pathlib.Path) -> tuple:
    """(3x4 transform, scale) written by `ns-train` next to its config."""
    document = json.loads(path.read_text(encoding="utf-8"))
    transform = np.asarray(document["transform"], dtype=np.float64)
    if transform.shape != (3, 4):
        raise ValueError("dataparser transform is not 3x4")
    return transform, float(document["scale"])


def load_applied_transform(transforms: pathlib.Path) -> np.ndarray | None:
    """The 3x4 `applied_transform` already baked into a `transforms.json` (None when absent)."""
    value = json.loads(transforms.read_text(encoding="utf-8")).get("applied_transform")
    if value is None:
        return None
    matrix = np.asarray(value, dtype=np.float64)
    return matrix if matrix.shape == (3, 4) else None


def to_training_frame(poses: np.ndarray, points: np.ndarray, transform: np.ndarray, scale: float, applied: np.ndarray | None = None) -> tuple:
    """Map cameras and sparse points (in the `transforms.json` frame) into the frame the splat file is written in.

    `transform` and `scale` come from `dataparser_transforms.json`; `applied` is the
    `applied_transform` of `transforms.json`, which `transform` already contains and
    which is therefore undone first.
    """
    full = np.eye(4)
    full[:3, :4] = transform
    if applied is not None:
        undo = np.eye(4)
        undo[:3, :4] = applied
        full = full @ np.linalg.inv(undo)
    rotation, translation = full[:3, :3], full[:3, 3]
    mapped_poses = np.einsum("ij,njk->nik", full, poses)
    mapped_poses[:, :3, 3] *= scale
    mapped_points = (points @ rotation.T + translation) * scale if len(points) else points
    return mapped_poses, mapped_points


def _unit(vector: np.ndarray) -> np.ndarray:
    norm = np.linalg.norm(vector)
    return vector / norm if norm > 1e-12 else vector


def plane_normal(points: np.ndarray) -> tuple:
    """Unit normal of the dominant plane of `points` and how planar they are (0 spherical .. 1 flat)."""
    centred = points - points.mean(axis=0)
    values, vectors = np.linalg.eigh(np.cov(centred.T))
    flatness = 1.0 - float(values[0] / values[1]) if values[1] > 1e-12 else 0.0
    return vectors[:, 0], max(0.0, min(1.0, flatness))


def estimate_up(poses: np.ndarray, points: np.ndarray | None = None) -> dict:
    """Up vector of the scene: mean camera up (OpenGL +Y of each camera), else the plane normal."""
    ups = poses[:, :3, 1]
    ups = ups / np.maximum(np.linalg.norm(ups, axis=1, keepdims=True), 1e-12)
    mean = ups.mean(axis=0)
    confidence = float(np.linalg.norm(mean))
    if confidence >= MIN_UP_CONFIDENCE:
        return {"method": "camera_up", "up": _unit(mean), "confidence": confidence}
    if points is not None and len(points) >= 20:
        normal, flatness = plane_normal(points)
        # Cameras looking face-on at the plane cannot tell a floor seen from above from a wall (a mural, the
        # subject class of this lane): for a wall the plane normal is horizontal, so "up" would be sideways.
        # Only oblique views, where the cameras stand off to the side of the plane, vouch for a floor.
        views = -poses[:, :3, 2]
        views = views / np.maximum(np.linalg.norm(views, axis=1, keepdims=True), 1e-12)
        face_on = float(np.abs(views @ normal).mean())
        if face_on < MAX_PLANE_FACE_ON:
            if np.dot(normal, mean) < 0:
                normal = -normal
            # A weak camera consensus still fixes the sign. Flatness says how planar the points are, not whether the
            # plane is horizontal, so the answer is capped below the trusted level (see PLANE_FALLBACK_MAX_CONFIDENCE).
            return {"method": "plane_normal", "up": _unit(normal), "confidence": min(flatness, PLANE_FALLBACK_MAX_CONFIDENCE)}
    if confidence > 1e-6:
        return {"method": "camera_up_weak", "up": _unit(mean), "confidence": confidence}
    return {"method": "assumed", "up": np.array([0.0, 0.0, 1.0]), "confidence": 0.0}


def estimate_front(poses: np.ndarray, centre: np.ndarray, up: np.ndarray) -> dict | None:
    """Horizontal direction from the subject towards the cameras, or None when they surround it."""
    offsets = poses[:, :3, 3] - centre
    horizontal = offsets - np.outer(offsets @ up, up)
    lengths = np.linalg.norm(horizontal, axis=1)
    keep = lengths > 1e-9
    if keep.sum() < 3:
        return None
    unit = horizontal[keep] / lengths[keep, None]
    mean = unit.mean(axis=0)
    confidence = float(np.linalg.norm(mean))
    if confidence < MIN_FRONT_CONFIDENCE:
        return None
    return {"front": _unit(mean), "confidence": confidence}


def rotation_between(source: np.ndarray, target: np.ndarray) -> np.ndarray:
    """Rotation matrix taking unit vector `source` onto unit vector `target`."""
    source, target = _unit(source), _unit(target)
    cross = np.cross(source, target)
    cosine = float(np.dot(source, target))
    if cosine < -1 + 1e-9:
        # Opposite vectors: half-turn about any axis perpendicular to `source`.
        axis = _unit(np.cross(source, np.array([1.0, 0.0, 0.0]) if abs(source[0]) < 0.9 else np.array([0.0, 1.0, 0.0])))
        return 2.0 * np.outer(axis, axis) - np.eye(3)
    skew = np.array([[0.0, -cross[2], cross[1]], [cross[2], 0.0, -cross[0]], [-cross[1], cross[0], 0.0]])
    return np.eye(3) + skew + skew @ skew / (1.0 + cosine)


def subject_box(points: np.ndarray) -> tuple:
    """Percentile box (min, max) of the sparse points: the tight subject, without outliers."""
    low = np.percentile(points, CROP_PERCENTILES[0], axis=0)
    high = np.percentile(points, CROP_PERCENTILES[1], axis=0)
    return low, high


def crop_box(points: np.ndarray) -> tuple:
    """The subject box grown by a margin: what survives a floater crop (min, max)."""
    low, high = subject_box(points)
    extent = high - low
    margin = np.maximum(CROP_MARGIN * extent, MIN_MARGIN_OF_LARGEST_EXTENT * float(extent.max()))
    return low - margin, high + margin


def viewer_matrix(up: np.ndarray | None, front: np.ndarray | None, centre: np.ndarray, size: float) -> np.ndarray:
    """4x4 matrix mapping splat coordinates to viewer coordinates (+Y up, front towards +Z, radius ~1).

    With `up` None nothing is rotated: the subject is only centred and scaled.
    """
    upright = rotation_between(up, np.array([0.0, 1.0, 0.0])) if up is not None else np.eye(3)
    yaw = np.eye(3)
    if up is not None and front is not None:
        rotated = upright @ front
        angle = -math.atan2(rotated[0], rotated[2])
        cosine, sine = math.cos(angle), math.sin(angle)
        yaw = np.array([[cosine, 0.0, sine], [0.0, 1.0, 0.0], [-sine, 0.0, cosine]])
    scale = VIEWER_RADIUS * 2.0 / size if size > 1e-12 else 1.0
    rotation = scale * (yaw @ upright)
    matrix = np.eye(4)
    matrix[:3, :3] = rotation
    matrix[:3, 3] = -rotation @ centre
    return matrix


def column_major(matrix: np.ndarray) -> list:
    """Flatten like three.js `Matrix4.toArray()` (columns one after another), rounded for a manifest."""
    return [round(float(value), 6) for value in matrix.T.reshape(-1)]


def analyse_scene(poses: np.ndarray, points: np.ndarray) -> dict:
    """Orientation, crop box and viewer transform from cameras and sparse points in the splat frame."""
    if len(points) >= 20:
        low, high = subject_box(points)
        centre = (low + high) / 2.0
        size = float((high - low).max())
        box_low, box_high = crop_box(points)
    else:
        # Too few points for a box: fall back to the camera cloud, which at least brackets the subject.
        positions = poses[:, :3, 3]
        centre = positions.mean(axis=0)
        size = float(np.linalg.norm(positions - centre, axis=1).max()) or 1.0
        box_low = box_high = None
    up = estimate_up(poses, points if len(points) else None)
    # Only a trusted answer (a consensus of the cameras' own up axes) may rotate the scene. A plane-normal, weak or
    # assumed answer is a guess: an obliquely photographed wall with rolled cameras looks like a floor, and acting on
    # it would open the mural sideways. Those scenes are centred and scaled but left unrotated.
    trusted = bool(up["method"] == "camera_up" and up["confidence"] >= MIN_UP_CONFIDENCE)
    front = estimate_front(poses, centre, up["up"]) if trusted else None
    matrix = viewer_matrix(up["up"] if trusted else None, front["front"] if front else None, centre, size)
    orientation: dict[str, Any] = {
        "method": up["method"],
        "confidence": round(up["confidence"], 3),
        # Only a consensus of the cameras' own up axes is a trusted answer; every other method is a heuristic.
        "trusted": trusted,
        # False when the answer was not trusted: the viewer transform then only centres and scales.
        "rotationApplied": trusted,
        "up": [round(float(v), 5) for v in up["up"]],
        "frontConfidence": round(front["confidence"], 3) if front else None,
        "front": [round(float(v), 5) for v in front["front"]] if front else None,
        "centre": [round(float(v), 5) for v in centre],
        "size": round(size, 5),
        "cameras": int(len(poses)),
        "points": int(len(points)),
    }
    result: dict[str, Any] = {"orientation": orientation, "matrix": column_major(matrix), "up": orientation["up"]}
    if box_low is not None:
        result["box"] = {
            "min": [round(float(v), 5) for v in box_low],
            "max": [round(float(v), 5) for v in box_high],
            "method": "sparse_point_percentile",
            "percentiles": list(CROP_PERCENTILES),
            "margin": CROP_MARGIN,
            "frame": "splat",
        }
    return result


def analyse_dataset(transforms: pathlib.Path, sparse_ply: pathlib.Path, dataparser: pathlib.Path) -> dict:
    """`analyse_scene` for a Nerfstudio dataset plus the transform `ns-train` applied to it."""
    poses = load_camera_poses(transforms)
    points = read_ascii_ply_points(sparse_ply) if sparse_ply.is_file() else np.zeros((0, 3))
    transform, scale = load_dataparser_transform(dataparser)
    poses, points = to_training_frame(poses, points, transform, scale, load_applied_transform(transforms))
    return analyse_scene(poses, points)
