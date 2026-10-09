"""Preview and runtime derivatives of a reconstruction master.

The master PLY is the archival source and is never modified. Two things are
derived from it, each by an established tool rather than a format written here:

- preview: the most important splats, re-encoded as SPZ by the Niantic `spz`
  library. Small enough to replicate widely and to draw within moments.
- runtime: a paged level-of-detail tree built by Spark's own `build-lod`, as a
  `.rad` header plus `.radc` chunks, which the Spark renderer pulls on demand.

Both tools are pinned in the worker image and their versions are reported with
every result, so a derivative always says what made it.
"""
from __future__ import annotations

import json
import os
import pathlib
import re
import shutil
import struct
import subprocess
import time
from typing import Any

from splat_ply import read_header, splat_count, write_reduced_ply
from worker_errors import WorkerError

# Spark 2.1.0 reads SPZ versions 1 to 3 and rejects 4. The `spz` library
# writes 4 unless told otherwise, which would produce a file the viewers cannot
# open, so the version is pinned to the newest one the renderer understands.
SPZ_VERSION = 3
BUILD_LOD_BINARY = os.environ.get("KUBUS_BUILD_LOD", "build-lod")
TOOLS_MANIFEST = pathlib.Path(os.environ.get("KUBUS_TOOLS_MANIFEST", "/opt/kubus/tools.json"))
BUNDLE_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
RAD_MAGIC = 0x30444152  # "RAD0", little endian


def tool_versions() -> dict[str, Any]:
    """Pinned versions recorded at image build time, or what can be read live."""
    try:
        return json.loads(TOOLS_MANIFEST.read_text())
    except (OSError, ValueError):
        return {}


def preview_target() -> int:
    return max(1_000, min(int(os.environ.get("KUBUS_PREVIEW_SPLATS", "100000")), 1_000_000))


def runtime_max_sh() -> int:
    return max(0, min(int(os.environ.get("KUBUS_RUNTIME_MAX_SH", "1")), 3))


def have_spz() -> bool:
    try:
        import spz  # noqa: F401
        return True
    except ImportError:
        return False


def have_build_lod() -> bool:
    return shutil.which(BUILD_LOD_BINARY) is not None


def generate_preview(master: pathlib.Path, output: pathlib.Path, target_splats: int | None = None) -> dict[str, Any]:
    """Writes `output/preview.spz` and returns its measured description."""
    try:
        import spz
    except ImportError as error:
        raise WorkerError("conversion_unsupported", "This worker image has no SPZ encoder; preview generation is unavailable.", 422) from error
    started = time.monotonic()
    target = target_splats or preview_target()
    output.mkdir(parents=True, exist_ok=True)
    reduced = output / "preview-source.ply"
    destination = output / "preview.spz"
    try:
        source_splats, kept = write_reduced_ply(master, reduced, target, drop_sh=True)
        unpack = spz.UnpackOptions()
        unpack.to_coord = spz.CoordinateSystem.RUB
        cloud = spz.load_splat_from_ply(str(reduced), unpack)
        pack = spz.PackOptions()
        pack.version = SPZ_VERSION
        pack.from_coord = spz.CoordinateSystem.RUB
        if not spz.save_spz(cloud, pack, str(destination)):
            raise WorkerError("preview_failed", "The SPZ encoder could not write the preview.", 500)
    except WorkerError:
        raise
    except Exception as error:  # the binding raises plain RuntimeError for bad input
        raise WorkerError("preview_failed", "The preview could not be generated from this master.", 500) from error
    finally:
        reduced.unlink(missing_ok=True)
    if not destination.is_file() or destination.stat().st_size == 0:
        raise WorkerError("preview_failed", "The preview encoder produced no output.", 500)
    versions = tool_versions()
    return {
        "path": f"{output.name}/preview.spz",
        "bytes": destination.stat().st_size,
        "sourceSplats": source_splats,
        "splats": kept,
        "sourceBytes": master.stat().st_size,
        "durationMs": int((time.monotonic() - started) * 1000),
        "tool": "spz",
        "toolVersion": str(versions.get("spz", {}).get("version", "unknown")),
        "settings": {"spzVersion": SPZ_VERSION, "targetSplats": target, "shDegree": 0},
    }


def read_rad_header(entry: pathlib.Path) -> dict[str, Any]:
    """Reads the JSON metadata block at the start of a `.rad` file.

    The file begins with a 4-byte magic and a 4-byte length, followed by that many
    bytes of JSON. Anything else is rejected rather than guessed at.
    """
    try:
        with open(entry, "rb") as handle:
            prefix = handle.read(8)
            if len(prefix) < 8:
                raise ValueError("short")
            magic, length = struct.unpack("<II", prefix)
            if magic != RAD_MAGIC or length < 2 or length > 64 * 1024 * 1024:
                raise ValueError("magic")
            return json.loads(handle.read(length).rstrip(b"\x00 \n"))
    except (OSError, ValueError, struct.error) as error:
        raise WorkerError("runtime_invalid", "The runtime tree is not a valid RAD file.", 500) from error


def build_runtime(master: pathlib.Path, output: pathlib.Path) -> dict[str, Any]:
    """Builds the paged LOD bundle in `output` and returns its measured description."""
    if not have_build_lod():
        raise WorkerError("conversion_unsupported", "This worker image has no LOD builder; runtime optimisation is unavailable.", 422)
    started = time.monotonic()
    source_splats = splat_count(master)
    if output.exists():
        shutil.rmtree(output)
    output.mkdir(parents=True)
    # build-lod writes beside its input and names outputs after it, so the master
    # is linked in as `scene.ply` and the link is removed once the tree is built.
    link = output / "scene.ply"
    os.symlink(master, link)
    command = [BUILD_LOD_BINARY, "--quality", "--rad-chunked", f"--max-sh={runtime_max_sh()}", str(link)]
    try:
        completed = subprocess.run(command, check=False, text=True, capture_output=True, timeout=4 * 60 * 60)
    except subprocess.TimeoutExpired as error:
        raise WorkerError("runtime_failed", "Building the runtime tree took too long and was stopped.", 504) from error
    finally:
        link.unlink(missing_ok=True)
    combined = (completed.stdout or "") + (completed.stderr or "")
    # build-lod reports a bad input by printing and returning normally, so the
    # exit status alone proves nothing: the outputs have to exist and be valid.
    if completed.returncode != 0 or "Decoding failed" in combined or "Stopping processing" in combined:
        raise WorkerError("runtime_failed", "The LOD builder rejected the reconstruction master.", 500)
    entry = output / "scene-lod.rad"
    if not entry.is_file():
        raise WorkerError("runtime_failed", "The LOD builder produced no tree.", 500)
    header = read_rad_header(entry)
    names = sorted(path.name for path in output.iterdir() if path.is_file())
    for name in names:
        if not BUNDLE_NAME.match(name):
            raise WorkerError("runtime_invalid", "The runtime bundle contains an unsafe file name.", 500)
    referenced = [chunk.get("filename") for chunk in header.get("chunks", []) if isinstance(chunk, dict) and chunk.get("filename")]
    missing = [name for name in referenced if name not in names]
    if missing or not referenced:
        raise WorkerError("runtime_invalid", "The runtime tree names chunk files that were not written.", 500)
    # Every chunk the header promises must be exactly as long as it says; a
    # truncated chunk would stall a viewer part-way through a scene.
    sizes = {chunk["filename"]: chunk.get("bytes") for chunk in header["chunks"] if isinstance(chunk, dict) and chunk.get("filename")}
    if any((output / name).stat().st_size != size for name, size in sizes.items()):
        raise WorkerError("runtime_invalid", "A runtime chunk is not the length its header states.", 500)
    # Nothing but the tree may ship: a stray file would be published unannounced.
    if set(names) != set(referenced) | {entry.name}:
        raise WorkerError("runtime_invalid", "The runtime bundle contains files the tree does not use.", 500)
    versions = tool_versions()
    total = sum((output / name).stat().st_size for name in names)
    return {
        "directory": output.name,
        "entrypoint": entry.name,
        "files": names,
        "bytes": total,
        "sourceSplats": source_splats,
        # `count` in the header is the size of the LOD tree, which includes the
        # merged parent splats; it is not the number of splats in the scene.
        "splats": None,
        "sourceBytes": master.stat().st_size,
        "durationMs": int((time.monotonic() - started) * 1000),
        "tool": "build-lod",
        "toolVersion": str(versions.get("buildLod", {}).get("version", "unknown")),
        "settings": {"method": "bhatt-lod", "chunked": True, "maxSh": runtime_max_sh(), "treeNodes": int(header.get("count", 0))},
    }
