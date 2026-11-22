"""Face masking for photographs and video frames, run before any reconstruction.

People who happen to be in front of a mural must not end up in a Gaussian splat.
This module finds faces with a pinned detector and replaces them with a solid
patch in the pixels themselves, so nothing about the face survives into the
images COLMAP and the trainer see.

Detector: YuNet (`face_detection_yunet_2023mar.onnx`) from OpenCV Zoo, run through
OpenCV's own `cv2.FaceDetectorYN`. Code and weights are MIT-licensed
(`models/LICENSE.yunet`, Shiqi Yu; the network was trained with
libfacedetection.train, BSD-3-Clause). The weights ship in the worker image and
are verified against a pinned SHA-256 before every use; a mismatch or a missing
file is an error, never a silent "no faces".

Tuned for recall. A missed face is worse than a patch over a flower:
- a low score threshold (0.4; the detector's own default is 0.9), with a layout check on the weak band,
- several passes: the whole image at two scales and overlapping native-resolution
  tiles, so small and distant faces are seen at a size the network handles,
- boxes from every pass are merged, then grown generously (forehead, hair line,
  ears, chin) before they are filled,
- a fill of one flat colour (the region's median colour), which cannot be undone.

A reviewed, per-image manual list refines the result: `add` boxes are masked as
given, `exclude` boxes drop detections that lie inside them (a painted face that is
part of the artwork). Both use fractions of the upright image (0..1), so a list
survives resizing. An exclude entry is `{"box": [x0, y0, x1, y1], "expectStrong": n,
"note": "..."}`, one box per painted feature (a bare `[x0, y0, x1, y1]` expects 0).
A real face inside an exclude box would silently stay unmasked, so the run counts
the near-certain detections (score 0.9 or more with a face-shaped layout) that each
box swallowed and FAILS unless the count equals `expectStrong`, which the reviewer
sets after looking at the image. A box covering more than a third of the image needs
`"allowLarge": true`. Nothing about a face is stored except the number of regions per
image.

A large face (wider than 12 percent of the short side) is masked only when near-certain (score 0.9 or more
with a face-shaped layout): the coarse passes that see large faces also score walls, and above all the painted
heads of the artwork itself, at 0.7 to 0.9, and a patch over a painted head destroys what is being captured
(measured on the six Head of Flowers sets: masking large detections from 0.7 patched whole painted heads and
added 46 regions in four of the six). Two things a run cannot decide are therefore reported for a human to
look at, never silently dropped: a detection that is not near-certain but lies inside an exclude box
(`weakExcluded`: a real, turned or occluded face next to a painted one would stay unmasked), and a large
detection of any score from 0.4 that failed the near-certain test and so was not masked (`largeBelowCertain`:
a close-up, hatted or sunglassed face scores lower, but so does a painted head or a wall). Both are counted per image, in the command line's report
(`needsLook`, listed under `review` and printed to stderr) and, for the worker, in the job's `faceMasking`
provenance (`needsLook`: the number of images and of detections, and which images), where a human looks before anything is
published (the Node refuses to publish a record with images left to look at until the operator acknowledges it). An exclude entry may state `"expectWeak": n` once the reviewer has looked, and then the run fails
if the count differs. Video frames also get a neighbour check (`mask_frame_sequence`): a face region that the
frame before and the frame after both have, and the frame between does not, is masked in the frame between.
Its limits: it fills only a one-frame gap between two frames that both have the region (two misses in a row,
a miss at the first or the last frame, and a face seen in one frame only are not covered), and it relies on
the selected frames being temporal neighbours.

Command line (also used from the Node's operator documentation):

    python face_mask.py mask INPUT_DIR OUTPUT_DIR [--manual FILE] [--contact DIR] [--discover]

writes masked copies, a `kubus-face-masking.json` report whose entries are bound
to the masked files by SHA-256, and optionally review sheets. The input is only
read.
"""
import hashlib
import json
import os
import pathlib
import sys
from typing import Any, Callable

MODEL_FILE = "face_detection_yunet_2023mar.onnx"
MODEL_SHA256 = "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4"
MODEL_DIRECTORY = pathlib.Path(os.environ.get("KUBUS_FACE_MODEL_DIR", str(pathlib.Path(__file__).resolve().parent / "models")))
DETECTOR_INFO = {
    "name": "YuNet",
    "model": "face_detection_yunet_2023mar",
    "source": "opencv/opencv_zoo@48b10fa505aeb51fbd127fc60a5c660040e823b7",
    "licence": "MIT",
    "runtime": "opencv FaceDetectorYN",
}
REPORT_SCHEMA = "kubus.face-masking/1"
REPORT_NAME = "kubus-face-masking.json"

# A detection at or above STRONG_SCORE is a face. Between SCORE_THRESHOLD and STRONG_SCORE it must also have a
# face-shaped layout of eyes, nose and mouth (`plausible_layout`), which removes the texture of a rough wall.
SCORE_THRESHOLD = float(os.environ.get("KUBUS_FACE_SCORE_THRESHOLD", "0.4"))
STRONG_SCORE = float(os.environ.get("KUBUS_FACE_STRONG_SCORE", "0.7"))
# A weak detection must also be a believable size in the full photo: not a speck of texture (below WEAK_MIN_WIDTH
# pixels, too small to identify anyone).
WEAK_MIN_WIDTH = 28
# A face wider than LARGE_FRACTION of the photo's short side is found only by the coarsest passes, where a plain
# wall, or a painted head, can score 0.8; there it must be near-certain (LARGE_MIN_SCORE and a face-shaped layout)
# to be masked. A large detection that is not is counted for a human to look at (`largeBelowCertain`).
LARGE_FRACTION = 0.12
LARGE_MIN_SCORE = 0.9
# An exclude box drops a detection only when its centre lies inside and at least this share of the detection's
# own area does, so a face merely beside a painted one is not swallowed. A box bigger than MAX_EXCLUDE_AREA of
# the image must say so (`allowLarge`).
EXCLUDE_CONTAINED = 0.5
MAX_EXCLUDE_AREA = 0.35
NMS_THRESHOLD = 0.3
# Whole-image passes (long side in pixels), then native-resolution tiles.
WHOLE_IMAGE_SIDES = (160, 320, 640, 1280, 2560)
# The network sees faces of about 10 to 300 pixels in its input and hallucinates beyond that. Every pass therefore
# only answers for faces of up to MAX_INPUT_FACE pixels in its own input, and the passes (a factor of two apart)
# together cover every face size from the tile scale up to a face that fills the photo.
MAX_INPUT_FACE = 160
TILE_SIZE = 960
TILE_STRIDE = 480
# Margins added to a detection, as fractions of its width and height.
PAD_SIDE, PAD_TOP, PAD_BOTTOM = 0.45, 0.7, 0.4
MIN_PAD_PIXELS = 6
# Boxes of different passes are one face above this intersection-over-union, or when one lies mostly inside the other.
MERGE_IOU = 0.3
MERGE_CONTAINED = 0.8


class FaceMaskingError(RuntimeError):
    """Masking could not run; the caller must stop rather than continue with unmasked pixels."""


def model_path() -> pathlib.Path:
    return MODEL_DIRECTORY / MODEL_FILE


def verify_weights() -> str:
    """SHA-256 of the weights file, checked against the pinned value."""
    try:
        digest = hashlib.sha256(model_path().read_bytes()).hexdigest()
    except OSError as error:
        raise FaceMaskingError("face detector weights are missing") from error
    if digest != MODEL_SHA256:
        raise FaceMaskingError("face detector weights do not match the pinned checksum")
    return digest


Box = tuple  # (x0, y0, x1, y1) in pixels


def _overlap_of_smaller(a: tuple, b: tuple) -> float:
    ix0, iy0, ix1, iy1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    smaller = min((a[2] - a[0]) * (a[3] - a[1]), (b[2] - b[0]) * (b[3] - b[1]))
    return ((ix1 - ix0) * (iy1 - iy0)) / smaller if smaller > 0 else 0.0


def plausible_layout(row: Any) -> bool:
    """Do the five landmarks of a YuNet row (right eye, left eye, nose, right and left mouth corner) look like a face?

    Rotation-invariant: everything is measured in the frame of the eye line, so a tilted or sideways head passes
    and random texture, whose landmarks are scattered, does not.
    """
    try:
        rex, rey, lex, ley, nx, ny, rmx, rmy, lmx, lmy = (float(value) for value in row[4:14])
    except (TypeError, ValueError):
        return False
    ux, uy = lex - rex, ley - rey
    eye = (ux * ux + uy * uy) ** 0.5
    width = float(row[2]) if float(row[2]) > 0 else 1.0
    if eye < 0.25 * width or eye > 1.0 * width:
        return False
    ux, uy = ux / eye, uy / eye
    vx, vy = -uy, ux  # "down" in the face's own frame

    def along(px: float, py: float) -> tuple:
        dx, dy = px - (rex + lex) / 2.0, py - (rey + ley) / 2.0
        return (dx * ux + dy * uy) / eye, (dx * vx + dy * vy) / eye

    nose_u, nose_v = along(nx, ny)
    rm_u, rm_v = along(rmx, rmy)
    lm_u, lm_v = along(lmx, lmy)
    mouth_v = (rm_v + lm_v) / 2.0
    return (
        0.2 <= nose_v <= 1.3 and abs(nose_u) <= 0.45
        and mouth_v > nose_v + 0.1 and mouth_v <= 2.0
        and lm_u > rm_u + 0.2 and lm_u - rm_u <= 1.4
        and abs(rm_v - lm_v) <= 0.6
    )


def _iou(a: tuple, b: tuple) -> float:
    ix0, iy0, ix1, iy1 = max(a[0], b[0]), max(a[1], b[1]), min(a[2], b[2]), min(a[3], b[3])
    if ix1 <= ix0 or iy1 <= iy0:
        return 0.0
    inter = (ix1 - ix0) * (iy1 - iy0)
    union = (a[2] - a[0]) * (a[3] - a[1]) + (b[2] - b[0]) * (b[3] - b[1]) - inter
    return inter / union if union > 0 else 0.0


def merge_detections(boxes: list) -> list:
    """One entry per face: the same face found by several passes is kept once (highest score first).

    Boxes are never united, so a cluster of false detections cannot grow into one huge patch.
    Entries are (x0, y0, x1, y1[, score[, strong]]); an entry without a score ranks lowest. The result is a list
    of ((x0, y0, x1, y1), strong), where `strong` is true when any pass found that face near-certainly.
    """
    ranked = sorted((tuple(box) for box in boxes), key=lambda box: box[4] if len(box) > 4 else 0.0, reverse=True)
    kept: list = []
    strong: list = []
    for box in ranked:
        is_strong = len(box) > 5 and bool(box[5])
        for index, other in enumerate(kept):
            if _iou(box, other) >= MERGE_IOU or _overlap_of_smaller(box, other) >= MERGE_CONTAINED:
                strong[index] = strong[index] or is_strong
                break
        else:
            kept.append(box)
            strong.append(is_strong)
    return [(tuple(box[:4]), flag) for box, flag in zip(kept, strong)]


def merge_boxes(boxes: list) -> list:
    """`merge_detections` without the strength flag."""
    return [box for box, _ in merge_detections(boxes)]


def grow_box(box: tuple, width: int, height: int) -> tuple:
    """The region that is filled for one detection: the face plus forehead, hair line, ears and chin."""
    x0, y0, x1, y1 = box
    w, h = x1 - x0, y1 - y0
    px = max(MIN_PAD_PIXELS, PAD_SIDE * w)
    return (
        int(max(0, round(x0 - px))),
        int(max(0, round(y0 - max(MIN_PAD_PIXELS, PAD_TOP * h)))),
        int(min(width, round(x1 + px))),
        int(min(height, round(y1 + max(MIN_PAD_PIXELS, PAD_BOTTOM * h)))),
    )


def _fraction_box(box: Any, width: int, height: int) -> tuple | None:
    try:
        x0, y0, x1, y1 = (float(value) for value in box)
    except (TypeError, ValueError):
        return None
    x0, x1 = sorted((min(max(x0, 0.0), 1.0), min(max(x1, 0.0), 1.0)))
    y0, y1 = sorted((min(max(y0, 0.0), 1.0), min(max(y1, 0.0), 1.0)))
    if x1 - x0 <= 0 or y1 - y0 <= 0:
        return None
    return (int(x0 * width), int(y0 * height), int(round(x1 * width)), int(round(y1 * height)))


def parse_excludes(raw: Any, width: int, height: int) -> list:
    """Exclude entries (a bare box, or {"box", "expectStrong", "allowLarge", "note"}) as dicts with a pixel box."""
    out = []
    for entry in raw or []:
        spec = entry if isinstance(entry, dict) else {"box": entry}
        pixels = _fraction_box(spec.get("box"), width, height)
        if not pixels:
            continue
        area = (pixels[2] - pixels[0]) * (pixels[3] - pixels[1]) / float(width * height)
        if area > MAX_EXCLUDE_AREA and spec.get("allowLarge") is not True:
            raise FaceMaskingError(f"an exclude box covers {area:.0%} of the image; it needs \"allowLarge\": true after confirming nobody stands in it")
        expect = spec.get("expectStrong", 0)
        expect_weak = spec.get("expectWeak")
        out.append({
            "pixels": pixels, "expect": expect if isinstance(expect, int) and expect >= 0 else 0, "seen": 0, "weak": 0,
            "expect_weak": expect_weak if isinstance(expect_weak, int) and not isinstance(expect_weak, bool) and expect_weak >= 0 else None,
        })
    return out


def excludes_detection(exclude: tuple, box: tuple) -> bool:
    """Is the detection inside the exclude box: its centre and at least EXCLUDE_CONTAINED of its area."""
    centre = ((box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0)
    if not (exclude[0] <= centre[0] <= exclude[2] and exclude[1] <= centre[1] <= exclude[3]):
        return False
    ix0, iy0, ix1, iy1 = max(box[0], exclude[0]), max(box[1], exclude[1]), min(box[2], exclude[2]), min(box[3], exclude[3])
    area = max(0.0, (box[2] - box[0]) * (box[3] - box[1]))
    return area > 0 and max(0.0, ix1 - ix0) * max(0.0, iy1 - iy0) / area >= EXCLUDE_CONTAINED


class FaceMasker:
    """Loads the pinned detector once; `mask_array` masks one upright RGB image."""

    def __init__(self, score_threshold: float = SCORE_THRESHOLD):
        self.weights_sha256 = verify_weights()
        try:
            import cv2  # present in the worker image; imported lazily so the module imports anywhere
        except ImportError as error:
            raise FaceMaskingError("OpenCV is not available") from error
        self._cv2 = cv2
        self.score_threshold = score_threshold
        try:
            self._detector = cv2.FaceDetectorYN.create(str(model_path()), "", (320, 320), score_threshold, NMS_THRESHOLD, 5000)
        except Exception as error:  # cv2.error and friends
            raise FaceMaskingError("the face detector could not be loaded") from error
        self.version = {"opencv": cv2.__version__, **DETECTOR_INFO, "weightsSha256": self.weights_sha256, "scoreThreshold": score_threshold}

    def _faces(self, bgr: Any, scale: float, offset_x: int, offset_y: int, short_side: float) -> list:
        skipped = getattr(self, "_large_skipped", None)
        height, width = bgr.shape[:2]
        if width < 16 or height < 16:
            return []
        self._detector.setInputSize((width, height))
        _, found = self._detector.detect(bgr)
        boxes = []
        if found is not None:
            for row in found:
                score = float(row[14])
                x, y, w, h = (float(value) for value in row[:4])
                if max(w, h) > MAX_INPUT_FACE:
                    continue
                native = w / scale
                layout = plausible_layout(row)
                if native > LARGE_FRACTION * short_side and not (score >= LARGE_MIN_SCORE and layout):
                    if skipped is not None:  # any score the detector returned (from the 0.4 threshold)
                        skipped.append((offset_x + x / scale, offset_y + y / scale, offset_x + (x + w) / scale, offset_y + (y + h) / scale, score))
                    continue
                if score < STRONG_SCORE and not (layout and native >= WEAK_MIN_WIDTH):
                    continue
                boxes.append((offset_x + x / scale, offset_y + y / scale, offset_x + (x + w) / scale, offset_y + (y + h) / scale, score, bool(score >= LARGE_MIN_SCORE and layout)))
        return boxes

    def detect(self, rgb: Any) -> list:
        """Face boxes (x0, y0, x1, y1) in pixels of `rgb`, merged across every pass."""
        return [box for box, _ in self.detect_detailed(rgb)]

    def detect_detailed(self, rgb: Any) -> list:
        """Like `detect`, as (box, strong) pairs: `strong` is a near-certain face (score 0.9+, face-shaped layout)."""
        cv2 = self._cv2
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        height, width = bgr.shape[:2]
        boxes: list = []
        self._large_skipped = []
        long_side = max(width, height)
        for side in WHOLE_IMAGE_SIDES:
            if side > long_side:
                continue
            factor = min(1.0, side / long_side)
            scaled = bgr if factor == 1.0 else cv2.resize(bgr, (max(16, round(width * factor)), max(16, round(height * factor))), interpolation=cv2.INTER_AREA)
            boxes += self._faces(scaled, factor, 0, 0, min(width, height))
        # Native-resolution tiles: a face 20 pixels wide in a 5000 pixel photo is seen at that size.
        for top in range(0, max(1, height - TILE_SIZE + TILE_STRIDE), TILE_STRIDE):
            for left in range(0, max(1, width - TILE_SIZE + TILE_STRIDE), TILE_STRIDE):
                tile = bgr[top:min(height, top + TILE_SIZE), left:min(width, left + TILE_SIZE)]
                boxes += self._faces(tile, 1.0, left, top, min(width, height))
        merged = merge_detections(boxes)
        # Large detections that were not masked (not near-certain), once per face and not where a mask already is.
        unmasked = [box for box, _ in merge_detections(self._large_skipped)
                    if not any(_iou(box, kept) >= MERGE_IOU or _overlap_of_smaller(box, kept) >= MERGE_CONTAINED for kept, _ in merged)]
        self.last_review = {"largeBelowCertain": len(unmasked)}
        return merged

    def find_regions(self, rgb: Any, manual: dict | None = None, audit: list | None = None, review: dict | None = None) -> list:
        """The pixel regions (x0, y0, x1, y1) to fill in `rgb`: detections grown to cover the head, plus manual `add` boxes.

        `manual` is {"add": [...], "exclude": [...]} in image fractions. Every exclude box must have swallowed exactly
        the number of near-certain detections its entry expects (`expectStrong`, default 0), and, when it states
        `expectWeak`, exactly that many weaker ones, or `FaceMaskingError` is raised. With `audit` given the check is
        not raised but appended there as {"box", "strongExcluded", "expectStrong", "weakExcluded", "expectWeak", "ok"}
        for every box, so a reviewer can see what each one swallowed. `review`, when given, receives the counts a human
        should look at: `weakExcluded` (weaker detections swallowed by an exclude box that did not state `expectWeak`)
        and `largeBelowCertain` (large detections of score 0.4 or more that were not masked because they were not near-certain).
        """
        height, width = rgb.shape[:2]
        manual = manual or {}
        excludes = parse_excludes(manual.get("exclude", []), width, height)
        regions = []
        for box, strong in self.detect_detailed(rgb):
            hit = next((e for e in excludes if excludes_detection(e["pixels"], box)), None)
            if hit is not None:
                hit["seen" if strong else "weak"] += 1
                continue
            regions.append(grow_box(box, width, height))
        mismatches = []
        for index, entry in enumerate(excludes):
            ok = entry["seen"] == entry["expect"] and (entry["expect_weak"] is None or entry["weak"] == entry["expect_weak"])
            if audit is not None:
                audit.append({"box": index, "strongExcluded": entry["seen"], "expectStrong": entry["expect"],
                              "weakExcluded": entry["weak"], "expectWeak": entry["expect_weak"], "ok": ok})
            elif not ok:
                mismatches.append(f"exclude box {index} swallowed {entry['seen']} near-certain and {entry['weak']} weaker face detection(s), expected {entry['expect']}"
                                  + (f" and {entry['expect_weak']}" if entry["expect_weak"] is not None else ""))
        if mismatches:
            raise FaceMaskingError("; ".join(mismatches) + " (look at the image, then set expectStrong / expectWeak)")
        if review is not None:
            review["weakExcluded"] = sum(entry["weak"] for entry in excludes if entry["expect_weak"] is None)
            review["largeBelowCertain"] = int((getattr(self, "last_review", None) or {}).get("largeBelowCertain", 0))
        added = [box for box in (_fraction_box(raw, width, height) for raw in manual.get("add", [])) if box]
        regions += added  # every region is filled; overlapping fills are harmless, a dropped one would leave pixels
        return regions

    def mask_array(self, rgb: Any, manual: dict | None = None, audit: list | None = None, review: dict | None = None) -> tuple:
        """Returns (masked copy, number of regions); see `find_regions` for `manual`, `audit` and `review`."""
        regions = self.find_regions(rgb, manual, audit, review)
        return fill_regions(rgb, regions), len(regions)


def fill_regions(rgb: Any, regions: list) -> Any:
    """A copy of `rgb` with every region replaced by one flat colour (its median), which cannot be undone."""
    import numpy as np

    out = np.array(rgb, copy=True)
    for x0, y0, x1, y1 in regions:
        if x1 <= x0 or y1 <= y0:
            continue
        patch = out[y0:y1, x0:x1]
        patch[:, :] = np.median(patch.reshape(-1, 3), axis=0).astype(out.dtype)
    return out


NEEDS_LOOK_LIST_LIMIT = 200


def needs_look(reviews: list | None, positions: list | None = None) -> dict:
    """What a human has to look at after a run, from the per-image review counts.

    `images` is how many images carry a flag, `weakExcluded` and `largeBelowCertain` the detections, and `items`
    says which images: `{"image": n, ...flags}` with `n` the 1-based number of the image in its own sequence (the
    photo's number in the capture, `photos/00001.jpg` is 1; the frame's number among the selected video frames).
    `positions` gives that number per review entry when entries were dropped before (an unreadable photo), else it
    is the entry's own position. The list is bounded (`itemsTruncated` says it was cut); the counts are not.
    """
    reviews = reviews or []
    items: list = []
    for index, item in enumerate(reviews):
        flags = {key: int(item.get(key, 0)) for key in ("weakExcluded", "largeBelowCertain") if item.get(key)}
        if flags:
            items.append({"image": int(positions[index]) if positions is not None and index < len(positions) else index + 1, **flags})
    out = {
        "images": len(items),
        "weakExcluded": sum(int(item.get("weakExcluded", 0)) for item in reviews),
        "largeBelowCertain": sum(int(item.get("largeBelowCertain", 0)) for item in reviews),
        "items": items[:NEEDS_LOOK_LIST_LIMIT],
    }
    if len(items) > NEEDS_LOOK_LIST_LIMIT:
        out["itemsTruncated"] = True
    return out


def summarise(counts: list, photo_images: int = 0, extra: dict | None = None, version: dict | None = None) -> dict:
    """The record of a masking run for provenance: no coordinates, just counts."""
    histogram: dict = {}
    for count in counts:
        histogram[str(count)] = histogram.get(str(count), 0) + 1
    summary = {
        "ran": True,
        "images": len(counts),
        "photoImages": photo_images,
        "regions": sum(counts),
        "imagesWithRegions": sum(1 for count in counts if count),
        "regionsPerImage": list(counts),
        "histogram": histogram,
    }
    if version:
        summary["detector"] = version.get("name")
        summary["model"] = version.get("model")
        summary["weightsSha256"] = version.get("weightsSha256")
        summary["scoreThreshold"] = version.get("scoreThreshold")
        summary["licence"] = version.get("licence")
        summary["opencv"] = version.get("opencv")
    summary.update(extra or {})
    return summary


def masking_provenance(masking: dict | None) -> dict | None:
    """The `faceMasking` provenance of a job from what the pipelines return as `masking`: per part, a summary or nothing."""
    if not masking or not masking.get("version"):
        return None
    out: dict = {}
    photos, video = masking.get("photos"), masking.get("video")
    if photos is not None:
        out["photos"] = summarise(photos, photo_images=len(photos), version=masking["version"], extra={"needsLook": needs_look(masking.get("photosReview"), masking.get("photosPositions"))})
    if video is not None:
        out["video"] = summarise(video, version=masking["version"], extra={"needsLook": needs_look(masking.get("videoReview"))})
    return out or None


def mask_file(masker: FaceMasker, path: pathlib.Path, manual: dict | None = None) -> int:
    """Masks a JPEG or PNG in place (already upright, as the pipelines write them); returns the region count."""
    import numpy as np
    from PIL import Image

    with Image.open(path) as opened:
        exif = opened.info.get("exif")
        image = opened.convert("RGB")
    masked, count = masker.mask_array(np.asarray(image), manual)
    result = Image.fromarray(masked)
    if path.suffix.lower() in (".jpg", ".jpeg"):
        result.save(path, "JPEG", quality=95, **({"exif": exif} if exif else {}))
    else:
        result.save(path, "PNG")
    return count


def mask_files(masker: FaceMasker, directory: pathlib.Path, names: list, progress: Callable[[int, int], None] | None = None) -> list:
    """Masks `directory/<name>` in place for every name; returns the region count of each."""
    counts = []
    for index, name in enumerate(names):
        counts.append(mask_file(masker, directory / name))
        if progress:
            progress(index + 1, len(names))
    return counts


def _near(a: tuple, b: tuple) -> bool:
    return _iou(a, b) >= MERGE_IOU or _overlap_of_smaller(a, b) >= MERGE_CONTAINED


def carry_over(regions_per_frame: list) -> list:
    """Per frame, the regions a neighbour check adds (see `mask_frame_sequence`): a region that the frame before and
    the frame after both have, where this frame has none of its own, is added here. Each side's region is added, so
    a face that moved between frames is covered at both places. Only interior frames are filled; the first and the
    last have one neighbour and nothing to be sure of."""
    added: list = [[] for _ in regions_per_frame]
    for index in range(1, len(regions_per_frame) - 1):
        before, here, after = regions_per_frame[index - 1], regions_per_frame[index], regions_per_frame[index + 1]
        for region in before:
            partner = next((other for other in after if _near(region, other)), None)
            if partner is None or any(_near(region, own) or _near(partner, own) for own in here + added[index]):
                continue
            added[index] += [region, partner]
    return added


def mask_frame_sequence(masker: "FaceMasker", directory: pathlib.Path, names: list, progress: Callable[[int, int], None] | None = None, review: list | None = None) -> list:
    """Masks the frames of a video, in order, with a neighbour check; returns the region count of each frame.

    Every frame is analysed on its own (nothing is written yet; an analysis failure leaves every file as it was),
    then each frame is filled with its own regions plus those `carry_over` adds, so a face the detector missed in
    one frame of a run of frames that have it is still masked. The write phase rewrites the files one by one: a
    failure in it (disk full, an encode error) can leave some frames masked and some not in `directory`, and the
    error is raised so the job stops and nothing in it is used. `carry_over` has limits, see the module docstring.
    With `review` (a list) each frame's `find_regions` review counts are appended to it, in order.
    """
    import numpy as np
    from PIL import Image

    found: list = []
    for index, name in enumerate(names):
        with Image.open(directory / name) as opened:
            image = opened.convert("RGB")
        frame_review: dict = {}
        found.append(masker.find_regions(np.asarray(image), review=frame_review))
        if review is not None:
            review.append(frame_review)
        if progress:
            progress(index + 1, len(names) * 2)
    extra = carry_over(found)
    counts = []
    for index, name in enumerate(names):
        path = directory / name
        with Image.open(path) as opened:
            exif = opened.info.get("exif")
            image = opened.convert("RGB")
        regions = found[index] + extra[index]
        result = Image.fromarray(fill_regions(np.asarray(image), regions))
        if path.suffix.lower() in (".jpg", ".jpeg"):
            result.save(path, "JPEG", quality=95, **({"exif": exif} if exif else {}))
        else:
            result.save(path, "PNG")
        counts.append(len(regions))
        if progress:
            progress(len(names) + index + 1, len(names) * 2)
    return counts


# ---- command line: masked copies of a directory, a report and review sheets ----

def _natural_key(name: str) -> list:
    import re
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", name)]


def to_srgb(image: Any, icc_profile: bytes | None) -> tuple:
    """(RGB image in sRGB, the ICC profile bytes to embed or None).

    Phones tag photos Display P3. The reconstruction and the viewer read pixel values as sRGB, so a P3 photo would
    come out slightly desaturated. A photo with a non-sRGB profile is converted to sRGB (perceptual intent, with
    black-point compensation off); one without a profile, or already sRGB, is returned unchanged. A profile that
    cannot be read is dropped and the pixels are left as they are.
    """
    if not icc_profile:
        return image, None
    try:
        import io
        from PIL import ImageCms

        source = ImageCms.ImageCmsProfile(io.BytesIO(icc_profile))
        if "srgb" in (ImageCms.getProfileDescription(source) or "").lower():
            return image, icc_profile
        target = ImageCms.createProfile("sRGB")
        converted = ImageCms.profileToProfile(image, source, target, renderingIntent=ImageCms.Intent.PERCEPTUAL, outputMode="RGB")
        return converted, ImageCms.ImageCmsProfile(target).tobytes()
    except Exception:  # an unreadable profile must not stop masking
        return image, None


def _sanitised_exif(opened: Any) -> bytes:
    """EXIF of the upright copy: camera, lens and time facts kept, location and thumbnail dropped, orientation reset."""
    from PIL import Image

    exif = Image.Exif()
    source = opened.getexif()
    for tag in (0x010F, 0x0110, 0x0132, 0x0131):
        if source.get(tag) is not None:
            exif[tag] = source.get(tag)
    ifd = source.get_ifd(0x8769)
    keep = {tag: ifd[tag] for tag in (0x9003, 0x9004, 0x9010, 0x9011, 0x920A, 0xA405, 0xA434) if tag in ifd}
    if keep:
        exif[0x8769] = keep
    return exif.tobytes()


def mask_directory(input_dir: pathlib.Path, output_dir: pathlib.Path, manual: dict | None = None, masker: FaceMasker | None = None, discover: bool = False) -> dict:
    """Writes masked copies of every JPEG/PNG in `input_dir` (non-recursive) to `output_dir`, never modifying the input.

    ICC profiles other than sRGB are converted to sRGB pixels (the copy carries an sRGB profile); location, thumbnail,
    XMP and the multi-picture (gain map) data are not carried. A manual exclude box whose count of swallowed
    near-certain detections differs from its `expectStrong` stops the run before the report is written; with
    `discover` the mismatches are returned in `excludeAudit` instead, for a reviewer to look at.
    """
    import numpy as np
    from PIL import Image, ImageOps

    masker = masker or FaceMasker()
    output_dir.mkdir(parents=True, exist_ok=True)
    manual = manual or {}
    names = sorted((entry.name for entry in input_dir.iterdir() if entry.is_file() and not entry.is_symlink() and entry.suffix.lower() in (".jpg", ".jpeg", ".png")), key=_natural_key)
    entries = []
    counts = []
    audits: list = []
    looks: list = []
    stems: dict = {}
    for name in names:
        stem = pathlib.Path(name).stem
        if stem in stems:
            raise FaceMaskingError(f"{name} and {stems[stem]} would write the same masked file ({stem}); rename one of them")
        stems[stem] = name
    for name in names:
        with Image.open(input_dir / name) as opened:
            # Pillow's own pixel limit stays on (it refuses a decompression bomb); a photo beyond it is an error.
            opened.load()
            # A two-picture JPEG (Ultra HDR, gain-map photos) is reported as MPO by Pillow; it is still a JPEG.
            exif = _sanitised_exif(opened) if opened.format in ("JPEG", "MPO") else None
            icc = opened.info.get("icc_profile")
            upright, icc = to_srgb(ImageOps.exif_transpose(opened).convert("RGB"), icc)
        audit: list = []
        review: dict = {}
        masked, count = masker.mask_array(np.asarray(upright), manual.get(name), audit=audit, review=review)
        for item in audit:
            if not item["ok"]:
                audits.append({"image": name, **item})
        needs_look = {key: value for key, value in review.items() if value}
        if needs_look:
            looks.append({"image": name, **needs_look})
        target = output_dir / (pathlib.Path(name).stem + (".jpg" if exif is not None else ".png"))
        result = Image.fromarray(masked)
        if exif is not None:
            result.save(target, "JPEG", quality=95, exif=exif, **({"icc_profile": icc} if icc else {}))
        else:
            result.save(target, "PNG", **({"icc_profile": icc} if icc else {}))
        counts.append(count)
        entry = manual.get(name) or {}
        entries.append({
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "regions": count,
            "manualAdded": len(entry.get("add", [])),
            "manualExcluded": len(entry.get("exclude", [])),
            **({"needsLook": needs_look} if needs_look else {}),
        })
    if audits and not discover:
        raise FaceMaskingError("exclude boxes do not match what was reviewed: " + json.dumps(audits))
    report = {
        "schema": REPORT_SCHEMA,
        "detector": masker.version,
        "images": entries,
        "totals": {"images": len(entries), "regions": sum(counts), "imagesWithRegions": sum(1 for count in counts if count),
                   "manualAdded": sum(item["manualAdded"] for item in entries), "manualExcluded": sum(item["manualExcluded"] for item in entries)},
    }
    if looks:
        # Not failures: places where the run cannot tell a face from a painted one or from a wall. A person looks.
        report["review"] = {"needsLook": looks}
    if audits:
        report["excludeAudit"] = audits  # only with `discover`; a report with mismatches must not be imported
    (output_dir / REPORT_NAME).write_text(json.dumps(report, indent=1) + "\n", encoding="utf-8")
    return report


def contact_sheets(directory: pathlib.Path, destination: pathlib.Path, per_sheet: int = 6, cell: int = 640) -> list:
    """Review sheets of the masked images (private; for a human to check), six per sheet, in name order."""
    from PIL import Image, ImageDraw

    destination.mkdir(parents=True, exist_ok=True)
    names = sorted((entry.name for entry in directory.iterdir() if entry.suffix.lower() in (".jpg", ".png")), key=_natural_key)
    written = []
    for start in range(0, len(names), per_sheet):
        group = names[start:start + per_sheet]
        columns = 3
        rows = (len(group) + columns - 1) // columns
        sheet = Image.new("RGB", (columns * cell, rows * cell), (30, 30, 30))
        for slot, name in enumerate(group):
            with Image.open(directory / name) as opened:
                tile = opened.convert("RGB")
                tile.thumbnail((cell - 8, cell - 8))
            x, y = (slot % columns) * cell + 4, (slot // columns) * cell + 4
            sheet.paste(tile, (x, y))
            ImageDraw.Draw(sheet).text((x + 6, y + 6), name, fill=(255, 255, 0))
        target = destination / f"sheet_{start // per_sheet + 1:02d}.jpg"
        sheet.save(target, "JPEG", quality=88)
        written.append(target)
    return written


def main(argv: list) -> int:
    if len(argv) < 4 or argv[1] != "mask":
        print(__doc__.split("Command line", 1)[1].strip().splitlines()[0] if "Command line" in __doc__ else "usage", file=sys.stderr)
        return 2
    input_dir, output_dir = pathlib.Path(argv[2]), pathlib.Path(argv[3])
    manual_file = contact_dir = None
    discover = False
    rest = argv[4:]
    while rest:
        flag = rest.pop(0)
        if flag == "--manual" and rest:
            manual_file = pathlib.Path(rest.pop(0))
        elif flag == "--contact" and rest:
            contact_dir = pathlib.Path(rest.pop(0))
        elif flag == "--discover":
            discover = True
        else:
            print(f"unknown option {flag}", file=sys.stderr)
            return 2
    manual = json.loads(manual_file.read_text(encoding="utf-8")) if manual_file else {}
    try:
        report = mask_directory(input_dir, output_dir, manual, discover=discover)
    except FaceMaskingError as error:
        print(f"face masking stopped: {error}", file=sys.stderr)
        return 1
    if contact_dir:
        contact_sheets(output_dir, contact_dir)
    print(json.dumps(report["totals"]))
    if report.get("review"):
        print(json.dumps({"needsLook": report["review"]["needsLook"]}), file=sys.stderr)
    if report.get("excludeAudit"):
        print(json.dumps({"excludeAudit": report["excludeAudit"]}))
        # The report that was written must not be imported: remove it so a discovery run cannot be attached.
        (output_dir / REPORT_NAME).unlink(missing_ok=True)
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
