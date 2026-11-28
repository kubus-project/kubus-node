"""Output stage of a prepared (managed) reconstruction: the full render derivative and the lightweight preview.

Two files are written from the trained PLY (`ns-export gaussian-splat`), and neither is that file:

* full: a render derivative. Same vertex count, order and float32 values for every property it keeps. The only thing
  dropped is the `nx`, `ny`, `nz` normals, and only when every one of them is exactly zero (splatfacto writes zero
  normals that no viewer reads). Every `f_rest_*` coefficient stays, so a render is pixel-identical by construction.
* lightweight: x y z, the three DC colour coefficients, opacity, scale and rotation as float32 (spherical-harmonic
  degree 0, 56 bytes per splat), pruned by importance until the whole file fits a byte budget.

The raw export is a provider intermediate; nothing here copies it. Input that is not a binary little-endian PLY with
float32 properties raises `WorkerError("output_conversion_failed")`; there is no fallback to shipping the raw file.
"""
import os
import pathlib
from typing import Any

import numpy as np

from video_pipeline import WorkerError

METHOD = "sh0-importance-prune/1"
OUTPUT_PROTOCOL = "kubus.spatial-output/2"
OUTPUT_VARIANTS = ["full", "lightweight"]
DEFAULT_BUDGET_BYTES = 20 * 1024 * 1024
MIN_BUDGET_BYTES = 1024 * 1024
BUDGET_ENV = "KUBUS_SPATIAL_LIGHTWEIGHT_MAX_BYTES"
LIGHTWEIGHT_PROPERTIES = (
    "x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity",
    "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3",
)
NORMALS = ("nx", "ny", "nz")
FLOAT_TYPES = ("float", "float32")
MAX_HEADER_BYTES = 64 * 1024
CHUNK_ROWS = 1 << 18


def _fail(message: str, **details: Any) -> WorkerError:
    return WorkerError("output_conversion_failed", message, 500, details)


def lightweight_budget(environ: dict[str, str] | None = None) -> int:
    """`KUBUS_SPATIAL_LIGHTWEIGHT_MAX_BYTES` clamped to 1 MiB..20 MiB; an unreadable value means the default."""
    raw = (os.environ if environ is None else environ).get(BUDGET_ENV)
    try:
        value = int(str(raw).strip()) if raw is not None else DEFAULT_BUDGET_BYTES
    except ValueError:
        value = DEFAULT_BUDGET_BYTES
    return max(MIN_BUDGET_BYTES, min(value, DEFAULT_BUDGET_BYTES))


class PlyFile:
    """A binary little-endian PLY with one vertex element of float32 properties, read through a memory map."""

    def __init__(self, path: pathlib.Path):
        self.path = pathlib.Path(path)
        try:
            with self.path.open("rb") as handle:
                head = handle.read(MAX_HEADER_BYTES)
        except OSError as error:
            raise _fail("The trained splat could not be read", reason=type(error).__name__)
        end = head.find(b"end_header\n")
        if not head.startswith(b"ply\n") or end < 0:
            raise _fail("The trained splat is not a PLY file", reason="not_ply")
        self.header_bytes = end + len(b"end_header\n")
        try:
            lines = head[:end].decode("ascii").split("\n")
        except UnicodeDecodeError:
            raise _fail("The trained splat has an unreadable header", reason="header_encoding")
        if "format binary_little_endian 1.0" not in lines:
            raise _fail("The trained splat is not a binary little-endian PLY", reason="format_unsupported")
        self.count = -1
        self.properties: list[str] = []
        elements = 0
        for line in lines[1:]:
            parts = line.split()
            if not parts or parts[0] in ("comment", "obj_info", "format"):
                continue
            if parts[0] == "element":
                elements += 1
                if elements > 1 or len(parts) != 3 or parts[1] != "vertex" or not parts[2].isdigit():
                    raise _fail("The trained splat has an unsupported element layout", reason="element_unsupported")
                self.count = int(parts[2])
            elif parts[0] == "property":
                if self.count < 0 or len(parts) != 3 or parts[1] not in FLOAT_TYPES:
                    raise _fail("The trained splat has a property that is not float32", reason="property_unsupported")
                self.properties.append(parts[2])
            else:
                raise _fail("The trained splat has an unsupported header line", reason="header_unsupported")
        if self.count < 1 or not self.properties or len(set(self.properties)) != len(self.properties):
            raise _fail("The trained splat has no vertices or a malformed property list", reason="vertex_layout")
        self.stride = 4 * len(self.properties)
        if self.path.stat().st_size != self.header_bytes + self.count * self.stride:
            raise _fail("The trained splat size does not match its header", reason="size_mismatch")
        self.index = {name: position for position, name in enumerate(self.properties)}

    def rows(self) -> np.ndarray:
        return np.memmap(self.path, dtype="<f4", mode="r", offset=self.header_bytes, shape=(self.count, len(self.properties)))

    def require(self, names: tuple[str, ...]) -> None:
        missing = [name for name in names if name not in self.index]
        if missing:
            raise _fail("The trained splat lacks properties the lightweight preview needs", reason="property_missing", missing=missing)


def ply_header(count: int, names: list[str] | tuple[str, ...]) -> bytes:
    lines = ["ply", "format binary_little_endian 1.0", f"element vertex {count}", *[f"property float {name}" for name in names], "end_header"]
    return ("\n".join(lines) + "\n").encode("ascii")


def _normals_all_zero(rows: np.ndarray, columns: list[int]) -> bool:
    for start in range(0, rows.shape[0], CHUNK_ROWS):
        if np.any(rows[start:start + CHUNK_ROWS][:, columns] != 0):
            return False
    return True


def _write_atomic(target: pathlib.Path, header: bytes, blocks) -> int:
    temporary = target.with_name(target.name + ".tmp")
    target.parent.mkdir(parents=True, exist_ok=True)
    size = 0
    try:
        with temporary.open("wb") as handle:
            handle.write(header)
            size += len(header)
            for block in blocks:
                data = np.ascontiguousarray(block, dtype="<f4").tobytes()
                handle.write(data)
                size += len(data)
        os.replace(temporary, target)
    finally:
        if temporary.exists():
            temporary.unlink()
    return size


def write_full(source: PlyFile, target: pathlib.Path) -> dict[str, Any]:
    """The render derivative: every splat and value kept, all-zero normals dropped."""
    rows = source.rows()
    normals = [source.index[name] for name in NORMALS if name in source.index]
    drop = normals if normals and _normals_all_zero(rows, normals) else []
    keep = [position for position in range(len(source.properties)) if position not in drop]
    names = [source.properties[position] for position in keep]

    def blocks():
        for start in range(0, source.count, CHUNK_ROWS):
            block = rows[start:start + CHUNK_ROWS]
            yield block if not drop else block[:, keep]

    size = _write_atomic(target, ply_header(source.count, names), blocks())
    return {"sizeBytes": size, "splats": source.count, "droppedNormals": bool(drop)}


def importance(opacity: np.ndarray, scales: np.ndarray) -> np.ndarray:
    """sigmoid(opacity) * exp(the sum of the two largest of scale_0..2); a non-finite score ranks last."""
    with np.errstate(over="ignore", invalid="ignore"):
        opacity64 = opacity.astype(np.float64)
        sigmoid = 1.0 / (1.0 + np.exp(-opacity64))
        ordered = np.sort(scales.astype(np.float64), axis=1)
        score = sigmoid * np.exp(ordered[:, 1] + ordered[:, 2])
    return np.where(np.isfinite(score), score, -1.0)


def max_kept_splats(source_splats: int, budget_bytes: int) -> int:
    """The largest N whose whole file (header included) fits the budget; the header grows with the digits of N."""
    width = 4 * len(LIGHTWEIGHT_PROPERTIES)
    kept = min(source_splats, max(0, (budget_bytes - len(ply_header(source_splats, LIGHTWEIGHT_PROPERTIES))) // width))
    while kept > 0 and len(ply_header(kept, LIGHTWEIGHT_PROPERTIES)) + kept * width > budget_bytes:
        kept -= 1
    # A shorter header for a smaller count can only free room, so grow while the next count still fits.
    while kept < source_splats and len(ply_header(kept + 1, LIGHTWEIGHT_PROPERTIES)) + (kept + 1) * width <= budget_bytes:
        kept += 1
    return kept


def write_lightweight(source: PlyFile, target: pathlib.Path, budget_bytes: int) -> dict[str, Any]:
    """SH degree 0 and the most important splats that fit `budget_bytes`, in their original order."""
    source.require(LIGHTWEIGHT_PROPERTIES)
    kept = max_kept_splats(source.count, budget_bytes)
    if kept < 1:
        raise _fail("The lightweight budget cannot hold a single splat", reason="budget_too_small", budgetBytes=budget_bytes)
    rows = source.rows()
    scale_columns = [source.index[f"scale_{axis}"] for axis in range(3)]
    score = importance(np.asarray(rows[:, source.index["opacity"]]), np.asarray(rows[:, scale_columns]))
    # Stable: equal scores keep the lower original index first, so the cut is deterministic.
    chosen = np.sort(np.argsort(-score, kind="stable")[:kept])
    columns = [source.index[name] for name in LIGHTWEIGHT_PROPERTIES]

    def blocks():
        for start in range(0, kept, CHUNK_ROWS):
            yield rows[chosen[start:start + CHUNK_ROWS]][:, columns]

    size = _write_atomic(target, ply_header(kept, LIGHTWEIGHT_PROPERTIES), blocks())
    if size > budget_bytes:
        raise _fail("The lightweight preview exceeded its budget", reason="budget_exceeded", sizeBytes=size, budgetBytes=budget_bytes)
    return {"sizeBytes": size, "splats": kept}


def convert_export(raw: pathlib.Path, output: pathlib.Path, budget_bytes: int | None = None) -> dict[str, Any]:
    """Writes `render/reconstruction.ply` and, when the full file is over budget, `render/reconstruction-light.ply`.

    Returns the worker result's pieces: `variants` (output-relative paths) and `lightweight` (the manifest record, or None).
    """
    budget = lightweight_budget() if budget_bytes is None else budget_bytes
    source = PlyFile(raw)
    full_path = output / "render" / "reconstruction.ply"
    full = write_full(source, full_path)
    variants = [{"role": "spatial_mobile", "path": "render/reconstruction.ply", "mimeType": "application/octet-stream", "format": "ply", "storageClass": "warm"}]
    lightweight = None
    if full["sizeBytes"] > budget:
        light = write_lightweight(source, output / "render" / "reconstruction-light.ply", budget)
        variants.append({"role": "spatial_preview", "path": "render/reconstruction-light.ply", "mimeType": "application/octet-stream", "format": "ply", "storageClass": "hot"})
        lightweight = {"method": METHOD, "sourceSplats": source.count, "keptSplats": light["splats"], "shDegree": 0, "budgetBytes": budget}
    return {"variants": variants, "lightweight": lightweight, "full": full}
