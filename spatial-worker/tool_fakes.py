"""Stand-ins for the two external tools, shared by the worker's tests.

`FakeSpz` replaces the `spz` module and records how the worker drives it;
`FAKE_BUILD_LOD` is a scripted `build-lod` whose behaviour is chosen by the
`FAKE_MODE` environment variable and which mimics the real tool's failure shapes
(it prints and exits 0 on an input it cannot decode, for instance).
"""
from __future__ import annotations

import gzip
import pathlib
import struct
import types

from splat_ply import read_header

SPZ_MAGIC_FOR_TESTS = 0x5053474E


class FakeSpz:
    """Records how the worker drives the encoder, and fails the ways the binding does."""

    def __init__(self, *, load_error: Exception | None = None, save_result: bool = True, write_output: bool = True,
                 written_points: int | None = None, written_version: int | None = None, raw_output: bytes | None = None) -> None:
        self.load_error, self.save_result, self.write_output = load_error, save_result, write_output
        self.written_points, self.written_version, self.raw_output = written_points, written_version, raw_output
        self.calls: list[tuple] = []
        self.loaded_points = 0

    def container(self, version: int) -> bytes:
        """A gzip container with a real SPZ v3 header and filler for the arrays."""
        points = self.loaded_points if self.written_points is None else self.written_points
        header = struct.pack("<IIIBBBB", SPZ_MAGIC_FOR_TESTS, self.written_version or version, points, 0, 12, 0, 0)
        return gzip.compress(header + b"\0" * 64)

    def module(self) -> types.ModuleType:
        fake = self
        module = types.ModuleType("spz")

        class CoordinateSystem:
            RDF = "RDF"
            RUB = "RUB"

        class UnpackOptions:
            def __init__(self) -> None:
                self.to_coord = "UNSPECIFIED"

        class PackOptions:
            def __init__(self) -> None:
                self.version = 4
                self.from_coord = "UNSPECIFIED"

        def load_splat_from_ply(path, options):
            fake.calls.append(("load", pathlib.Path(path).name, options.to_coord, pathlib.Path(path).is_file()))
            if fake.load_error:
                raise fake.load_error
            fake.loaded_points = read_header(pathlib.Path(path)).vertex_count
            return object()

        def save_spz(cloud, options, path):
            fake.calls.append(("save", options.version, options.from_coord))
            if fake.write_output:
                pathlib.Path(path).write_bytes(fake.raw_output if fake.raw_output is not None else fake.container(options.version))
            return fake.save_result

        module.CoordinateSystem, module.UnpackOptions, module.PackOptions = CoordinateSystem, UnpackOptions, PackOptions
        module.load_splat_from_ply, module.save_spz = load_splat_from_ply, save_spz
        return module


FAKE_BUILD_LOD = '''#!{python}
"""A stand-in for build-lod. FAKE_MODE picks the behaviour; the arguments it was given are recorded."""
import json, os, pathlib, struct, sys

link = pathlib.Path(sys.argv[-1])
out = link.parent
mode = os.environ.get("FAKE_MODE", "ok")
pathlib.Path(os.environ["FAKE_ARGS"]).write_text(json.dumps({{"argv": sys.argv[1:], "linkIsSymlink": link.is_symlink(), "cwd": os.getcwd()}}))

def rad(chunks, **overrides):
    header = {{"version": 1, "type": "gsplat", "count": 12, "maxSh": 1, "lodTree": True, "chunkSize": 65536,
              "allChunkBytes": sum(len(b) for b in chunks.values()), "chunks": [], "splatEncoding": {{}}}}
    offset = 0
    for name, body in chunks.items():
        (out / name).write_bytes(body)
        header["chunks"].append({{"offset": offset, "bytes": len(body), "filename": name}})
        offset += len(body)
    header.update(overrides)
    payload = json.dumps(header).encode()
    (out / "scene-lod.rad").write_bytes(struct.pack("<II", 0x30444152, len(payload)) + payload)

if mode == "ok":
    rad({{"scene-lod-0.radc": b"a" * 100, "scene-lod-1.radc": b"b" * 50}})
elif mode == "decode_failed":          # the real tool prints and exits 0 on an input it cannot decode
    print("Decoding failed: unsupported property layout")
elif mode == "stopping":
    print("Stopping processing")
elif mode == "exit_nonzero":
    print("boom", file=sys.stderr); sys.exit(3)
elif mode == "no_output":
    pass
elif mode == "garbage_entry":
    (out / "scene-lod.rad").write_bytes(b"not a rad file at all")
elif mode == "missing_chunk":
    rad({{"scene-lod-0.radc": b"a" * 10}})
    (out / "scene-lod-0.radc").unlink()
elif mode == "no_chunks":
    rad({{}})
elif mode == "short_chunk":
    rad({{"scene-lod-0.radc": b"a" * 100}})
    (out / "scene-lod-0.radc").write_bytes(b"a" * 40)
elif mode == "stray_file":
    rad({{"scene-lod-0.radc": b"a" * 10}})
    (out / "notes.txt").write_text("not part of the tree")
elif mode == "unsafe_name":
    rad({{"-rf.radc": b"a" * 10}})
elif mode == "hang":
    import time; time.sleep(60)
'''
