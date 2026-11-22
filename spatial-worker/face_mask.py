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
given, `exclude` boxes drop detections whose centre lies inside them (a painted
face that is part of the artwork). Both use fractions of the upright image
(0..1), so a list survives resizing. Nothing about a face is stored except the
number of regions per image.

Command line (also used from the Node's operator documentation):

    python face_mask.py mask INPUT_DIR OUTPUT_DIR [--manual FILE] [--contact DIR]

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
# A face wider than LARGE_FRACTION of the photo's short side is found only by the coarsest passes, where a
# plain wall can score 0.8; there it must be near-certain and have a face-shaped layout.
LARGE_FRACTION = 0.12
LARGE_MIN_SCORE = 0.9
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


def merge_boxes(boxes: list) -> list:
    """One box per face: the same face found by several passes is kept once (highest score first).

    Boxes are never united, so a cluster of false detections cannot grow into one huge patch.
    Entries are (x0, y0, x1, y1[, score]); an entry without a score ranks lowest.
    """
    ranked = sorted((tuple(box) for box in boxes), key=lambda box: box[4] if len(box) > 4 else 0.0, reverse=True)
    kept: list = []
    for box in ranked:
        if all(_iou(box, other) < MERGE_IOU and _overlap_of_smaller(box, other) < MERGE_CONTAINED for other in kept):
            kept.append(box)
    return [box[:4] for box in kept]


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
                if native > LARGE_FRACTION * short_side and not (score >= LARGE_MIN_SCORE and plausible_layout(row)):
                    continue
                if score < STRONG_SCORE and not (plausible_layout(row) and native >= WEAK_MIN_WIDTH):
                    continue
                boxes.append((offset_x + x / scale, offset_y + y / scale, offset_x + (x + w) / scale, offset_y + (y + h) / scale, score))
        return boxes

    def detect(self, rgb: Any) -> list:
        """Face boxes (x0, y0, x1, y1) in pixels of `rgb`, merged across every pass."""
        cv2 = self._cv2
        bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
        height, width = bgr.shape[:2]
        boxes: list = []
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
        return merge_boxes(boxes)

    def mask_array(self, rgb: Any, manual: dict | None = None) -> tuple:
        """Returns (masked copy, number of regions). `manual` is {"add": [...], "exclude": [...]} in image fractions."""
        import numpy as np

        height, width = rgb.shape[:2]
        manual = manual or {}
        excludes = [box for box in (_fraction_box(raw, width, height) for raw in manual.get("exclude", [])) if box]
        regions = []
        for box in self.detect(rgb):
            centre = ((box[0] + box[2]) / 2.0, (box[1] + box[3]) / 2.0)
            if any(e[0] <= centre[0] <= e[2] and e[1] <= centre[1] <= e[3] for e in excludes):
                continue
            regions.append(grow_box(box, width, height))
        added = [box for box in (_fraction_box(raw, width, height) for raw in manual.get("add", [])) if box]
        regions += added  # every region is filled; overlapping fills are harmless, a dropped one would leave pixels
        out = np.array(rgb, copy=True)
        for x0, y0, x1, y1 in regions:
            if x1 <= x0 or y1 <= y0:
                continue
            patch = out[y0:y1, x0:x1]
            patch[:, :] = np.median(patch.reshape(-1, 3), axis=0).astype(out.dtype)  # one flat colour: irreversible
        return out, len(regions)


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
        out["photos"] = summarise(photos, photo_images=len(photos), version=masking["version"])
    if video is not None:
        out["video"] = summarise(video, version=masking["version"])
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


# ---- command line: masked copies of a directory, a report and review sheets ----

def _natural_key(name: str) -> list:
    import re
    return [int(part) if part.isdigit() else part.lower() for part in re.split(r"(\d+)", name)]


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


def mask_directory(input_dir: pathlib.Path, output_dir: pathlib.Path, manual: dict | None = None, masker: FaceMasker | None = None) -> dict:
    """Writes masked copies of every JPEG/PNG in `input_dir` (non-recursive) to `output_dir`, never modifying the input."""
    import numpy as np
    from PIL import Image, ImageOps

    masker = masker or FaceMasker()
    output_dir.mkdir(parents=True, exist_ok=True)
    manual = manual or {}
    names = sorted((entry.name for entry in input_dir.iterdir() if entry.is_file() and not entry.is_symlink() and entry.suffix.lower() in (".jpg", ".jpeg", ".png")), key=_natural_key)
    entries = []
    counts = []
    Image.MAX_IMAGE_PIXELS = None
    for name in names:
        with Image.open(input_dir / name) as opened:
            opened.load()
            exif = _sanitised_exif(opened) if opened.format == "JPEG" else None
            upright = ImageOps.exif_transpose(opened).convert("RGB")
        masked, count = masker.mask_array(np.asarray(upright), manual.get(name))
        target = output_dir / (pathlib.Path(name).stem + (".jpg" if exif is not None else ".png"))
        result = Image.fromarray(masked)
        if exif is not None:
            result.save(target, "JPEG", quality=95, exif=exif)
        else:
            result.save(target, "PNG")
        counts.append(count)
        entry = manual.get(name) or {}
        entries.append({
            "sha256": hashlib.sha256(target.read_bytes()).hexdigest(),
            "regions": count,
            "manualAdded": len(entry.get("add", [])),
            "manualExcluded": len(entry.get("exclude", [])),
        })
    report = {
        "schema": REPORT_SCHEMA,
        "detector": masker.version,
        "images": entries,
        "totals": {"images": len(entries), "regions": sum(counts), "imagesWithRegions": sum(1 for count in counts if count),
                   "manualAdded": sum(item["manualAdded"] for item in entries), "manualExcluded": sum(item["manualExcluded"] for item in entries)},
    }
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
    rest = argv[4:]
    while rest:
        flag = rest.pop(0)
        if flag == "--manual" and rest:
            manual_file = pathlib.Path(rest.pop(0))
        elif flag == "--contact" and rest:
            contact_dir = pathlib.Path(rest.pop(0))
        else:
            print(f"unknown option {flag}", file=sys.stderr)
            return 2
    manual = json.loads(manual_file.read_text(encoding="utf-8")) if manual_file else {}
    report = mask_directory(input_dir, output_dir, manual)
    if contact_dir:
        contact_sheets(output_dir, contact_dir)
    print(json.dumps(report["totals"]))
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
