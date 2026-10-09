"""Shared fixtures. The worker's modules sit beside the tests, so put this directory on the path."""
from __future__ import annotations

import json
import pathlib
import sys

import numpy as np
import pytest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent))

from synthetic_splat import PROPERTIES, synthesize, write_ply  # noqa: E402


def write_custom_ply(path: pathlib.Path, rows: np.ndarray, properties: list[str], extra_header: str = "", fmt: str = "binary_little_endian 1.0") -> pathlib.Path:
    """A PLY with exactly the given float properties, for building malformed or minimal inputs."""
    header = f"ply\nformat {fmt}\n{extra_header}element vertex {rows.shape[0]}\n" + "".join(f"property float {name}\n" for name in properties) + "end_header\n"
    path.write_bytes(header.encode("ascii") + np.ascontiguousarray(rows, dtype="<f4").tobytes())
    return path


def pytest_configure(config):
    config.addinivalue_line("markers", "real_tools: runs the pinned spz / build-lod binaries; skipped where they are not installed")


@pytest.fixture
def make_master(tmp_path):
    """Writes a synthetic reconstruction master and returns its path."""
    def make(splats: int = 3000, seed: int = 7, name: str = "master.ply") -> pathlib.Path:
        path = tmp_path / name
        write_ply(path, synthesize(splats, seed))
        return path
    return make


@pytest.fixture
def master(make_master):
    return make_master()


@pytest.fixture
def properties() -> list[str]:
    return list(PROPERTIES)


@pytest.fixture
def tools_manifest(tmp_path, monkeypatch):
    """A tools manifest as the image build writes it, in effect for the test."""
    import derivatives
    path = tmp_path / "tools.json"
    path.write_text(json.dumps({"buildLod": {"version": "spark-v2.1.0", "ref": "f" * 40}, "spz": {"version": "v3.0.0", "ref": "a" * 40}}))
    monkeypatch.setattr(derivatives, "TOOLS_MANIFEST", path)
    return path
