"""Derivative generation: the contract with the encoder and the LOD builder.

Two layers, kept apart on purpose.

- Tests that stand in for the tools (a recording `spz` module, a scripted
  `build-lod`) pin how the worker drives them and how it reacts when they fail
  in the ways the real ones do. They run anywhere.
- Tests marked `real_tools` run the pinned binaries on a synthetic master and
  check the output independently of the worker's own reader. They are skipped,
  and say so, when a tool is not installed; they are the evidence that the
  worker's assumptions about the tools are true, so a CI run that skips them has
  not proved that.

    KUBUS_BUILD_LOD=/path/to/build-lod python -m pytest spatial-worker
"""
from __future__ import annotations

import gzip
import json
import os
import pathlib
import stat
import struct
import sys

import numpy as np
import pytest

import derivatives
from derivatives import BUNDLE_NAME, RAD_MAGIC, SPZ_VERSION, build_runtime, generate_preview, read_rad_header
from splat_ply import read_header
from synthetic_splat import PROPERTIES
from tool_fakes import FAKE_BUILD_LOD, FakeSpz
from worker_errors import WorkerError

real_spz = pytest.mark.skipif(not derivatives.have_spz(), reason="the spz encoder is not installed")
real_build_lod = pytest.mark.skipif(not derivatives.have_build_lod(), reason="build-lod is not installed (set KUBUS_BUILD_LOD)")


# --- helpers ---------------------------------------------------------------

def master_positions(path: pathlib.Path) -> np.ndarray:
    header = read_header(path)
    data = np.memmap(path, dtype=header.dtype(), mode="r", offset=header.data_offset, shape=(header.vertex_count,))
    return np.stack([data["x"], data["y"], data["z"]], axis=1).astype(np.float64)


def read_spz(path: pathlib.Path) -> dict:
    """An independent reader of the SPZ v3 container, written from the format and not from the worker.

    A gzip stream holding a 16-byte header (magic "NGSP", version, point count,
    SH degree, fractional bits, flags, reserved) and then planar arrays: 24-bit
    positions, alphas, colours, scales, rotations, SH.
    """
    raw = gzip.decompress(path.read_bytes())
    magic, version, count, sh_degree, fractional_bits, flags, reserved = struct.unpack("<IIIBBBB", raw[:16])
    positions_raw = np.frombuffer(raw, dtype=np.uint8, count=count * 9, offset=16).reshape(count, 3, 3).astype(np.int32)
    value = positions_raw[:, :, 0] | (positions_raw[:, :, 1] << 8) | (positions_raw[:, :, 2] << 16)
    value = np.where(value & 0x800000, value - 0x1000000, value)
    return {
        "magic": magic, "version": version, "count": count, "shDegree": sh_degree, "fractionalBits": fractional_bits,
        "positions": value.astype(np.float64) / float(1 << fractional_bits), "size": len(raw),
    }


def write_rad(directory: pathlib.Path, chunks: dict[str, bytes], **overrides) -> pathlib.Path:
    """A RAD entry in the layout `build-lod --rad-chunked` writes, beside its chunk files."""
    directory.mkdir(parents=True, exist_ok=True)
    header: dict = {
        "version": 1, "type": "gsplat", "count": 10, "maxSh": 1, "lodTree": True, "chunkSize": 65536,
        "allChunkBytes": sum(len(body) for body in chunks.values()),
        "chunks": [], "splatEncoding": {},
    }
    offset = 0
    for name, body in chunks.items():
        (directory / name).write_bytes(body)
        header["chunks"].append({"offset": offset, "bytes": len(body), "filename": name})
        offset += len(body)
    header.update(overrides)
    payload = json.dumps(header).encode()
    entry = directory / "scene-lod.rad"
    entry.write_bytes(struct.pack("<II", RAD_MAGIC, len(payload)) + payload)
    return entry


# --- tool provenance --------------------------------------------------------

def test_tool_versions_reads_the_manifest_written_at_image_build(tools_manifest):
    versions = derivatives.tool_versions()
    assert versions["buildLod"]["version"] == "spark-v2.1.0"
    assert versions["spz"]["ref"] == "a" * 40


def test_tool_versions_is_empty_rather_than_invented_when_the_manifest_is_missing_or_broken(tmp_path, monkeypatch):
    monkeypatch.setattr(derivatives, "TOOLS_MANIFEST", tmp_path / "absent.json")
    assert derivatives.tool_versions() == {}
    broken = tmp_path / "broken.json"
    broken.write_text("{not json")
    monkeypatch.setattr(derivatives, "TOOLS_MANIFEST", broken)
    assert derivatives.tool_versions() == {}


def test_a_missing_manifest_is_reported_as_unknown_version_not_a_guess(master, tmp_path, monkeypatch):
    monkeypatch.setattr(derivatives, "TOOLS_MANIFEST", tmp_path / "absent.json")
    monkeypatch.setitem(sys.modules, "spz", FakeSpz().module())
    assert generate_preview(master, tmp_path / "out", 1000)["toolVersion"] == "unknown"


def test_the_dockerfile_pins_what_the_manifest_and_the_code_assume():
    """The version recorded in a result must be the version the image built, and Spark 2.1.0 reads SPZ 1-3 only."""
    text = (pathlib.Path(__file__).parent / "Dockerfile").read_text()
    assert "ARG SPARK_REF=f22236f95fdd8078f0c12e3aab479523d401daf6" in text
    assert "ARG SPZ_REF=5bf2945de1a003cee07133b1e495fe9c6ffdc7e7" in text
    assert text.count("ARG SPARK_REF=") == 2 and text.count("ARG SPZ_REF=") == 2  # build stage and manifest stage agree
    assert '"version":"spark-v2.1.0"' in text and '"version":"v3.0.0"' in text
    assert SPZ_VERSION == 3


def test_environment_tunables_are_clamped(monkeypatch):
    monkeypatch.setenv("KUBUS_PREVIEW_SPLATS", "5")
    assert derivatives.preview_target() == 1_000
    monkeypatch.setenv("KUBUS_PREVIEW_SPLATS", "999999999")
    assert derivatives.preview_target() == 1_000_000
    monkeypatch.delenv("KUBUS_PREVIEW_SPLATS")
    assert derivatives.preview_target() == 100_000
    monkeypatch.setenv("KUBUS_RUNTIME_MAX_SH", "-4")
    assert derivatives.runtime_max_sh() == 0
    monkeypatch.setenv("KUBUS_RUNTIME_MAX_SH", "9")
    assert derivatives.runtime_max_sh() == 3


# --- preview, against a recording stand-in for spz -------------------------

def use_fake_spz(monkeypatch, **options) -> FakeSpz:
    fake = FakeSpz(**options)
    monkeypatch.setitem(sys.modules, "spz", fake.module())
    return fake


def test_preview_declares_the_cloud_rdf_in_and_rub_out_so_nothing_is_converted(master, tmp_path, monkeypatch, tools_manifest):
    """Regression: RUB at both ends rotated every preview half a turn about X (upside down in Spark)."""
    fake = use_fake_spz(monkeypatch)
    generate_preview(master, tmp_path / "out", 1000)
    load = next(call for call in fake.calls if call[0] == "load")
    save = next(call for call in fake.calls if call[0] == "save")
    assert load[2] == "RDF"
    assert save[1] == SPZ_VERSION == 3, "the library's own default is version 4, which Spark 2.1.0 rejects"
    assert save[2] == "RUB"


def test_preview_reports_what_was_measured_and_what_made_it(master, tmp_path, monkeypatch, tools_manifest):
    use_fake_spz(monkeypatch)
    result = generate_preview(master, tmp_path / "out", 1000)
    assert result["path"] == "out/preview.spz"
    assert result["bytes"] == (tmp_path / "out" / "preview.spz").stat().st_size
    assert (result["sourceSplats"], result["splats"]) == (3000, 1000)
    assert result["sourceBytes"] == master.stat().st_size
    assert result["tool"] == "spz" and result["toolVersion"] == "v3.0.0"
    assert result["settings"] == {"spzVersion": 3, "targetSplats": 1000, "shDegree": 0, "frame": "master"}


def test_preview_never_touches_the_master_and_leaves_only_the_spz(master, tmp_path, monkeypatch):
    use_fake_spz(monkeypatch)
    before = master.read_bytes()
    generate_preview(master, tmp_path / "out", 1000)
    assert master.read_bytes() == before
    assert sorted(path.name for path in (tmp_path / "out").iterdir()) == ["preview.spz"]


def test_the_intermediate_ply_is_present_while_encoding_and_removed_after_a_failure(master, tmp_path, monkeypatch):
    fake = use_fake_spz(monkeypatch, save_result=False)
    with pytest.raises(WorkerError) as caught:
        generate_preview(master, tmp_path / "out", 1000)
    assert caught.value.code == "preview_failed"
    assert fake.calls[0] == ("load", "preview-source.ply", "RDF", True)
    assert not (tmp_path / "out" / "preview-source.ply").exists()


@pytest.mark.parametrize("failure", [RuntimeError("bad ply"), ValueError("oops"), OSError("disk")])
def test_a_binding_exception_becomes_a_coded_failure_without_the_tools_words(master, tmp_path, monkeypatch, failure):
    use_fake_spz(monkeypatch, load_error=failure)
    with pytest.raises(WorkerError) as caught:
        generate_preview(master, tmp_path / "out", 1000)
    assert (caught.value.code, caught.value.status) == ("preview_failed", 500)
    assert str(failure) not in caught.value.message
    assert not (tmp_path / "out" / "preview-source.ply").exists()


def test_an_empty_or_missing_output_is_a_failure_even_when_the_encoder_says_it_succeeded(master, tmp_path, monkeypatch):
    use_fake_spz(monkeypatch, write_output=False)
    with pytest.raises(WorkerError) as missing:
        generate_preview(master, tmp_path / "a", 1000)
    assert missing.value.code == "preview_failed"

    use_fake_spz(monkeypatch)

    def empty(cloud, options, path):
        pathlib.Path(path).write_bytes(b"")
        return True

    sys.modules["spz"].save_spz = empty
    with pytest.raises(WorkerError) as empty_file:
        generate_preview(master, tmp_path / "b", 1000)
    assert empty_file.value.code == "preview_failed"


def test_a_container_that_holds_fewer_splats_than_were_given_is_a_failure(master, tmp_path, monkeypatch):
    """The real binding logs a missing field and still writes a valid, empty container; success from it proves nothing."""
    use_fake_spz(monkeypatch, written_points=0)
    with pytest.raises(WorkerError) as caught:
        generate_preview(master, tmp_path / "out", 1000)
    assert caught.value.code == "preview_failed"


def test_a_container_in_a_version_the_renderer_cannot_read_is_a_failure(master, tmp_path, monkeypatch):
    use_fake_spz(monkeypatch, written_version=4)
    with pytest.raises(WorkerError) as caught:
        generate_preview(master, tmp_path / "out", 1000)
    assert caught.value.code == "preview_failed"


@pytest.mark.parametrize("raw", [b"not gzip at all", gzip.compress(b"short"), gzip.compress(struct.pack("<IIIBBBB", 0xDEADBEEF, 3, 1000, 0, 12, 0, 0))])
def test_output_that_is_not_an_spz_container_is_rejected(master, tmp_path, monkeypatch, raw):
    use_fake_spz(monkeypatch, raw_output=raw)
    with pytest.raises(WorkerError) as caught:
        generate_preview(master, tmp_path / "out", 1000)
    assert caught.value.code == "preview_invalid"


def test_a_worker_without_the_encoder_refuses_instead_of_pretending(master, tmp_path, monkeypatch):
    monkeypatch.setitem(sys.modules, "spz", None)  # makes `import spz` raise ImportError
    assert derivatives.have_spz() is False
    with pytest.raises(WorkerError) as caught:
        generate_preview(master, tmp_path / "out", 1000)
    assert (caught.value.code, caught.value.status) == ("conversion_unsupported", 422)


def test_a_malformed_master_fails_with_the_master_error_not_a_preview_error(tmp_path, monkeypatch):
    use_fake_spz(monkeypatch)
    not_a_ply = tmp_path / "bad.ply"
    not_a_ply.write_bytes(b"this is not a ply")
    with pytest.raises(WorkerError) as caught:
        generate_preview(not_a_ply, tmp_path / "out", 1000)
    assert caught.value.code == "master_invalid"


# --- runtime, against a scripted build-lod ----------------------------------



@pytest.fixture
def fake_lod(tmp_path, monkeypatch, tools_manifest):
    script = tmp_path / "bin" / "build-lod"
    script.parent.mkdir()
    script.write_text(FAKE_BUILD_LOD.format(python=sys.executable))
    script.chmod(script.stat().st_mode | stat.S_IXUSR)
    args = tmp_path / "args.json"
    monkeypatch.setattr(derivatives, "BUILD_LOD_BINARY", str(script))
    monkeypatch.setenv("FAKE_ARGS", str(args))

    def mode(name: str) -> None:
        monkeypatch.setenv("FAKE_MODE", name)

    mode.args = lambda: json.loads(args.read_text())
    return mode


def test_runtime_invokes_the_pinned_flags_on_a_link_named_scene_ply(master, tmp_path, fake_lod):
    fake_lod("ok")
    build_runtime(master, tmp_path / "runtime")
    recorded = fake_lod.args()
    assert recorded["argv"][:3] == ["--quality", "--rad-chunked", "--max-sh=1"]
    assert pathlib.Path(recorded["argv"][-1]).name == "scene.ply"
    assert recorded["linkIsSymlink"] is True


def test_runtime_removes_the_link_so_the_bundle_holds_only_the_tree(master, tmp_path, fake_lod):
    fake_lod("ok")
    result = build_runtime(master, tmp_path / "runtime")
    assert not (tmp_path / "runtime" / "scene.ply").exists()
    assert result["files"] == ["scene-lod-0.radc", "scene-lod-1.radc", "scene-lod.rad"]
    assert result["entrypoint"] == "scene-lod.rad" and result["directory"] == "runtime"


def test_runtime_reports_measured_sizes_and_the_tool_that_made_it(master, tmp_path, fake_lod):
    fake_lod("ok")
    result = build_runtime(master, tmp_path / "runtime")
    entry_size = (tmp_path / "runtime" / "scene-lod.rad").stat().st_size
    assert result["bytes"] == 150 + entry_size
    assert result["sourceSplats"] == 3000 and result["splats"] is None, "the header's count is the tree, not the scene"
    assert result["sourceBytes"] == master.stat().st_size
    assert (result["tool"], result["toolVersion"]) == ("build-lod", "spark-v2.1.0")
    assert result["settings"] == {"method": "bhatt-lod", "chunked": True, "maxSh": 1, "treeNodes": 12}


def test_runtime_honours_the_configured_sh_degree(master, tmp_path, fake_lod, monkeypatch):
    monkeypatch.setenv("KUBUS_RUNTIME_MAX_SH", "0")
    fake_lod("ok")
    result = build_runtime(master, tmp_path / "runtime")
    assert "--max-sh=0" in fake_lod.args()["argv"] and result["settings"]["maxSh"] == 0


def test_runtime_replaces_a_previous_build_instead_of_mixing_with_it(master, tmp_path, fake_lod):
    stale = tmp_path / "runtime"
    stale.mkdir()
    (stale / "left-over-from-last-time.radc").write_bytes(b"stale")
    fake_lod("ok")
    result = build_runtime(master, stale)
    assert "left-over-from-last-time.radc" not in result["files"]
    assert not (stale / "left-over-from-last-time.radc").exists()


def test_the_master_is_not_modified_by_a_build(master, tmp_path, fake_lod):
    before = master.read_bytes()
    fake_lod("ok")
    build_runtime(master, tmp_path / "runtime")
    assert master.read_bytes() == before


@pytest.mark.parametrize("mode", ["decode_failed", "stopping", "exit_nonzero"])
def test_the_tools_ways_of_rejecting_an_input_become_runtime_failed(master, tmp_path, fake_lod, mode):
    """build-lod prints and returns 0 on a bad input, so the text matters as much as the status."""
    fake_lod(mode)
    with pytest.raises(WorkerError) as caught:
        build_runtime(master, tmp_path / "runtime")
    assert (caught.value.code, caught.value.status) == ("runtime_failed", 500)
    assert "Decoding" not in caught.value.message and "boom" not in caught.value.message
    assert not (tmp_path / "runtime" / "scene.ply").exists(), "the link is removed even on failure"


def test_a_tool_that_exits_cleanly_without_a_tree_is_a_failure(master, tmp_path, fake_lod):
    fake_lod("no_output")
    with pytest.raises(WorkerError) as caught:
        build_runtime(master, tmp_path / "runtime")
    assert caught.value.code == "runtime_failed"


@pytest.mark.parametrize("mode,code", [
    ("garbage_entry", "runtime_invalid"),
    ("missing_chunk", "runtime_invalid"),
    ("no_chunks", "runtime_invalid"),
    ("short_chunk", "runtime_invalid"),
    ("stray_file", "runtime_invalid"),
    ("unsafe_name", "runtime_invalid"),
])
def test_an_output_that_cannot_be_published_is_rejected_with_a_specific_code(master, tmp_path, fake_lod, mode, code):
    fake_lod(mode)
    with pytest.raises(WorkerError) as caught:
        build_runtime(master, tmp_path / "runtime")
    assert caught.value.code == code


def test_a_timeout_is_reported_as_a_timeout_and_the_link_is_removed(master, tmp_path, fake_lod, monkeypatch):
    fake_lod("hang")
    real_run = derivatives.subprocess.run

    def quick(*args, **kwargs):
        kwargs["timeout"] = 0.3
        return real_run(*args, **kwargs)

    monkeypatch.setattr(derivatives.subprocess, "run", quick)
    with pytest.raises(WorkerError) as caught:
        build_runtime(master, tmp_path / "runtime")
    assert (caught.value.code, caught.value.status) == ("runtime_failed", 504)
    assert not (tmp_path / "runtime" / "scene.ply").exists()


def test_a_worker_without_build_lod_refuses_instead_of_pretending(master, tmp_path, monkeypatch):
    monkeypatch.setattr(derivatives, "BUILD_LOD_BINARY", str(tmp_path / "does-not-exist"))
    assert derivatives.have_build_lod() is False
    with pytest.raises(WorkerError) as caught:
        build_runtime(master, tmp_path / "runtime")
    assert (caught.value.code, caught.value.status) == ("conversion_unsupported", 422)


def test_every_published_file_name_satisfies_the_grammar_the_node_enforces(master, tmp_path, fake_lod):
    fake_lod("ok")
    result = build_runtime(master, tmp_path / "runtime")
    assert all(BUNDLE_NAME.match(name) for name in result["files"])
    for hostile in ["", ".hidden", "-flag", "a/b", "..", "a b", "x" * 129, "café.radc"]:
        assert not BUNDLE_NAME.match(hostile), hostile


def test_rad_header_reading_rejects_everything_that_is_not_a_rad_file(tmp_path):
    cases = {
        "empty": b"",
        "short": b"RAD",
        "wrong magic": struct.pack("<II", 0x12345678, 2) + b"{}",
        "zero length": struct.pack("<II", RAD_MAGIC, 0),
        "absurd length": struct.pack("<II", RAD_MAGIC, 0x7FFFFFFF) + b"{}",
        "not json": struct.pack("<II", RAD_MAGIC, 5) + b"nope!",
    }
    for label, body in cases.items():
        path = tmp_path / f"{label.replace(' ', '_')}.rad"
        path.write_bytes(body)
        with pytest.raises(WorkerError) as caught:
            read_rad_header(path)
        assert caught.value.code == "runtime_invalid", label
    with pytest.raises(WorkerError):
        read_rad_header(tmp_path / "missing.rad")


def test_rad_header_reading_accepts_a_padded_block(tmp_path):
    payload = b'{"chunks": []}' + b"\x00\x00  \n"
    path = tmp_path / "padded.rad"
    path.write_bytes(struct.pack("<II", RAD_MAGIC, len(payload)) + payload)
    assert read_rad_header(path) == {"chunks": []}


# --- real tools -------------------------------------------------------------

@pytest.mark.skipif(os.environ.get("KUBUS_REQUIRE_REAL_TOOLS") != "1", reason="only enforced where the pinned tools are supposed to be installed")
def test_the_pinned_tools_are_present_when_the_run_requires_them():
    """CI sets KUBUS_REQUIRE_REAL_TOOLS=1: a skip there would pass without proving the worker's assumptions."""
    assert derivatives.have_spz(), "the spz binding is not importable"
    assert derivatives.have_build_lod(), "build-lod is not on the path (KUBUS_BUILD_LOD)"
    versions = derivatives.tool_versions()
    assert versions["buildLod"]["version"] == "spark-v2.1.0" and versions["spz"]["version"] == "v3.0.0"


@pytest.mark.real_tools
@real_spz
def test_real_preview_is_spz_v3_in_the_masters_own_frame(make_master, tmp_path):
    """The numeric half of the orientation proof. The rendered half is the browser harness run in CI-less review."""
    master = make_master(3000, seed=11)
    result = generate_preview(master, tmp_path / "out", 3000)
    spz_file = read_spz(tmp_path / "out" / "preview.spz")

    assert spz_file["magic"] == 0x5053474E  # "NGSP"
    assert spz_file["version"] == 3
    assert spz_file["count"] == 3000 == result["splats"]
    assert spz_file["shDegree"] == 0

    # Every target splat is kept (target == count), in original order, so the file's
    # position i is the master's position i up to the format's fixed-point step.
    step = 1.0 / (1 << spz_file["fractionalBits"])
    expected = master_positions(master)
    error = np.abs(spz_file["positions"] - expected)
    assert error.max() <= step / 2 + 1e-6, f"max error {error.max()} exceeds half a quantisation step ({step / 2})"
    # The pre-fix behaviour put every point at (x, -y, -z). Show that is distinguishable here.
    flipped = expected * np.array([1.0, -1.0, -1.0])
    assert np.abs(spz_file["positions"] - flipped).max() > 0.5


@pytest.mark.real_tools
@real_spz
def test_real_preview_keeps_the_most_important_splats_and_stays_within_budget(make_master, tmp_path):
    master = make_master(5000, seed=3)
    result = generate_preview(master, tmp_path / "out", 1200)
    spz_file = read_spz(tmp_path / "out" / "preview.spz")
    assert spz_file["count"] == 1200 == result["splats"]
    assert result["bytes"] < master.stat().st_size / 10
    assert read_header(master).vertex_count == 5000


@pytest.mark.real_tools
@real_spz
def test_real_preview_is_byte_stable_for_the_same_master(make_master, tmp_path):
    """Characterisation: the same master and settings give the same bytes, so a re-run is not a new CID."""
    master = make_master(2000, seed=5)
    generate_preview(master, tmp_path / "one", 1000)
    generate_preview(master, tmp_path / "two", 1000)
    assert (tmp_path / "one" / "preview.spz").read_bytes() == (tmp_path / "two" / "preview.spz").read_bytes()


@pytest.mark.real_tools
@real_spz
def test_real_encoder_silently_writing_an_empty_container_is_caught(tmp_path):
    from conftest import write_custom_ply
    rows = np.zeros((10, len(PROPERTIES) - 1), dtype=np.float32)
    # A PLY that is a splat by the worker's own reader (all required properties) but not by the
    # encoder's (no f_dc colour). The real binding logs the missing field and writes an empty,
    # valid container instead of raising, so only the header check can catch it.
    names = [name for name in PROPERTIES if name != "f_dc_0"]
    master = write_custom_ply(tmp_path / "no-colour.ply", rows, names)
    with pytest.raises(WorkerError) as caught:
        generate_preview(master, tmp_path / "out", 1000)
    assert caught.value.code == "preview_failed"
    assert not (tmp_path / "out" / "preview-source.ply").exists()


@pytest.mark.real_tools
@real_build_lod
def test_real_runtime_is_a_valid_paged_rad_bundle(make_master, tmp_path):
    master = make_master(8000, seed=9)
    result = build_runtime(master, tmp_path / "runtime")
    directory = tmp_path / "runtime"

    assert result["entrypoint"] == "scene-lod.rad"
    assert set(result["files"]) == {path.name for path in directory.iterdir()}
    header = read_rad_header(directory / "scene-lod.rad")

    assert header["type"] == "gsplat" and header["lodTree"] is True
    chunks = header["chunks"]
    assert chunks, "a paged tree must name at least one chunk"
    assert sum(chunk["bytes"] for chunk in chunks) == header["allChunkBytes"]
    offset = 0
    for chunk in chunks:
        assert chunk["offset"] == offset, "chunks are contiguous"
        assert (directory / chunk["filename"]).stat().st_size == chunk["bytes"]
        offset += chunk["bytes"]
    assert {chunk["filename"] for chunk in chunks} | {"scene-lod.rad"} == set(result["files"])
    assert header["count"] >= 8000, "the LOD tree includes the source splats and their merged parents"
    assert result["settings"]["treeNodes"] == header["count"]
    assert not (directory / "scene.ply").exists()


@pytest.mark.real_tools
@real_build_lod
def test_real_runtime_splits_a_large_scene_across_several_chunks(make_master, tmp_path):
    master = make_master(150_000, seed=2)
    build_runtime(master, tmp_path / "runtime")
    header = read_rad_header(tmp_path / "runtime" / "scene-lod.rad")
    assert len(header["chunks"]) >= 2, "paging only helps when there is more than one page"
    assert all(chunk["bytes"] > 0 for chunk in header["chunks"])


@pytest.mark.real_tools
@real_build_lod
def test_real_runtime_records_the_pinned_tool_version_when_the_manifest_exists(make_master, tmp_path, monkeypatch, tools_manifest):
    result = build_runtime(make_master(2000), tmp_path / "runtime")
    assert (result["tool"], result["toolVersion"]) == ("build-lod", "spark-v2.1.0")


@pytest.mark.real_tools
@real_build_lod
def test_real_runtime_rejects_what_the_tool_cannot_decode(tmp_path):
    from conftest import write_custom_ply
    # Structurally a splat to the worker's own reader, but values the tool cannot decode.
    names = list(PROPERTIES)
    master = write_custom_ply(tmp_path / "nan.ply", np.full((50, len(names)), np.nan, dtype=np.float32), names)
    with pytest.raises(WorkerError) as caught:
        build_runtime(master, tmp_path / "runtime")
    assert (caught.value.code, caught.value.status) == ("runtime_failed", 500)
    assert not (tmp_path / "runtime" / "scene.ply").exists()
