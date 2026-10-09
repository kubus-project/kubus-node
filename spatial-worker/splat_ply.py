"""Binary Gaussian-splat PLY access without loading the file into memory.

A reconstruction master can be hundreds of megabytes. Everything here works on
a read-only memory map, scores splats in bounded chunks and only ever
materialises the rows it keeps, so preview generation costs memory in
proportion to the preview, not to the master.
"""
from __future__ import annotations

import dataclasses
import pathlib

import numpy as np

from worker_errors import WorkerError

_PLY_TYPES = {
    "float": "<f4", "float32": "<f4", "double": "<f8", "float64": "<f8",
    "uchar": "u1", "uint8": "u1", "char": "i1", "int8": "i1",
    "ushort": "<u2", "uint16": "<u2", "short": "<i2", "int16": "<i2",
    "uint": "<u4", "uint32": "<u4", "int": "<i4", "int32": "<i4",
}
_MAX_HEADER_BYTES = 64 * 1024
_REQUIRED = ("x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3")


@dataclasses.dataclass(frozen=True)
class PlyHeader:
    vertex_count: int
    properties: tuple[tuple[str, str], ...]  # (name, numpy dtype string)
    data_offset: int

    @property
    def row_bytes(self) -> int:
        return int(np.dtype([(name, kind) for name, kind in self.properties]).itemsize)

    def dtype(self) -> np.dtype:
        return np.dtype([(name, kind) for name, kind in self.properties])


def read_header(path: pathlib.Path) -> PlyHeader:
    """Parses and validates a binary little-endian Gaussian-splat PLY header."""
    try:
        with open(path, "rb") as handle:
            raw = handle.read(_MAX_HEADER_BYTES)
        size = path.stat().st_size
    except OSError as error:
        raise WorkerError("master_missing", "The reconstruction master could not be read.", 422) from error
    end_marker = b"end_header\n"
    end = raw.find(end_marker)
    if not raw.startswith(b"ply") or end < 0:
        raise WorkerError("master_invalid", "The reconstruction master is not a PLY file.", 422)
    lines = raw[:end].decode("ascii", errors="replace").splitlines()
    if len(lines) < 3 or lines[1].strip() != "format binary_little_endian 1.0":
        raise WorkerError("master_invalid", "Only binary little-endian PLY masters are supported.", 422)
    vertex_count = -1
    properties: list[tuple[str, str]] = []
    in_vertex = False
    for line in lines[2:]:
        parts = line.split()
        if not parts:
            continue
        if parts[0] == "element":
            in_vertex = len(parts) == 3 and parts[1] == "vertex"
            if in_vertex:
                try:
                    vertex_count = int(parts[2])
                except ValueError as error:
                    raise WorkerError("master_invalid", "The PLY vertex count is not a number.", 422) from error
            elif vertex_count >= 0:
                raise WorkerError("master_invalid", "The PLY master has unexpected elements after its vertices.", 422)
        elif parts[0] == "property" and in_vertex:
            if len(parts) != 3 or parts[1] not in _PLY_TYPES:
                raise WorkerError("master_invalid", "The PLY master uses a property type this worker does not read.", 422)
            properties.append((parts[2], _PLY_TYPES[parts[1]]))
    if vertex_count < 1:
        raise WorkerError("master_invalid", "The PLY master contains no splats.", 422)
    names = {name for name, _ in properties}
    missing = [name for name in _REQUIRED if name not in names]
    if missing:
        raise WorkerError("master_invalid", f"The PLY master is not a Gaussian splat (missing {missing[0]}).", 422)
    header = PlyHeader(vertex_count, tuple(properties), end + len(end_marker))
    if header.data_offset + header.row_bytes * vertex_count != size:
        raise WorkerError("master_invalid", "The PLY master is truncated or has trailing data.", 422)
    return header


def splat_count(path: pathlib.Path) -> int:
    return read_header(path).vertex_count


def _importance(rows: np.ndarray) -> np.ndarray:
    """Opacity times volume: the splats that carry the most of the picture."""
    opacity = 1.0 / (1.0 + np.exp(-rows["opacity"].astype(np.float64)))
    log_volume = rows["scale_0"].astype(np.float64) + rows["scale_1"].astype(np.float64) + rows["scale_2"].astype(np.float64)
    return opacity * np.exp(np.clip(log_volume, -60.0, 60.0))


def write_reduced_ply(
    master: pathlib.Path,
    destination: pathlib.Path,
    keep: int,
    drop_sh: bool = True,
    chunk_rows: int = 1_000_000,
) -> tuple[int, int]:
    """Writes the `keep` most important splats of `master` as a new PLY.

    Returns (source_splats, kept_splats). Selection is deterministic: ties break
    towards the lower row index, and rows keep their original order.
    """
    if keep < 1:
        raise WorkerError("preview_invalid_target", "The preview splat target must be positive.", 422)
    header = read_header(master)
    data = np.memmap(master, dtype=header.dtype(), mode="r", offset=header.data_offset, shape=(header.vertex_count,))
    total = header.vertex_count
    if keep >= total:
        selected = np.arange(total, dtype=np.int64)
    else:
        scores = np.empty(total, dtype=np.float64)
        for start in range(0, total, chunk_rows):
            scores[start:start + chunk_rows] = _importance(data[start:start + chunk_rows])
        # argpartition is not stable; the explicit tie-break keeps runs reproducible.
        order = np.lexsort((np.arange(total), -scores))
        selected = np.sort(order[:keep])
    out_properties = [(n, k) for n, k in header.properties if not (drop_sh and n.startswith("f_rest_"))]
    out_dtype = np.dtype(out_properties)
    text = "ply\nformat binary_little_endian 1.0\n" + f"element vertex {selected.size}\n"
    text += "".join(f"property {_ply_name(kind)} {name}\n" for name, kind in out_properties) + "end_header\n"
    with open(destination, "wb") as handle:
        handle.write(text.encode("ascii"))
        for start in range(0, selected.size, chunk_rows):
            block = data[selected[start:start + chunk_rows]]
            out = np.empty(block.shape[0], dtype=out_dtype)
            for name, _ in out_properties:
                out[name] = block[name]
            handle.write(out.tobytes())
    del data
    return total, int(selected.size)


def _ply_name(kind: str) -> str:
    for name, candidate in _PLY_TYPES.items():
        if candidate == kind and name in ("float", "double", "uchar", "char", "ushort", "short", "uint", "int"):
            return name
    raise WorkerError("master_invalid", "Unsupported PLY property type.", 422)
