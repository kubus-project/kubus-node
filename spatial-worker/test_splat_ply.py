"""Binary Gaussian-splat PLY reading and preview reduction."""
from __future__ import annotations

import numpy as np
import pytest

from conftest import write_custom_ply
from splat_ply import read_header, splat_count, write_reduced_ply
from synthetic_splat import PROPERTIES, synthesize, write_ply
from worker_errors import WorkerError

REQUIRED = ["x", "y", "z", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]


def code_of(call) -> tuple[str, int]:
    with pytest.raises(WorkerError) as raised:
        call()
    return raised.value.code, raised.value.status


class TestReadHeader:
    def test_reads_the_layout_the_exporter_writes(self, master):
        header = read_header(master)
        assert header.vertex_count == 3000
        assert [name for name, _ in header.properties] == PROPERTIES
        assert header.row_bytes == len(PROPERTIES) * 4
        assert splat_count(master) == 3000

    def test_accepts_a_file_with_only_the_required_properties(self, tmp_path):
        rows = np.zeros((10, len(REQUIRED)), dtype=np.float32)
        assert read_header(write_custom_ply(tmp_path / "min.ply", rows, REQUIRED)).vertex_count == 10

    def test_rejects_what_is_not_a_ply(self, tmp_path):
        path = tmp_path / "x.ply"
        path.write_bytes(b"not a ply file at all")
        assert code_of(lambda: read_header(path)) == ("master_invalid", 422)

    def test_rejects_a_missing_file_as_unavailable_not_as_invalid(self, tmp_path):
        assert code_of(lambda: read_header(tmp_path / "nope.ply")) == ("master_missing", 422)

    @pytest.mark.parametrize("fmt", ["ascii 1.0", "binary_big_endian 1.0"])
    def test_rejects_formats_it_does_not_read(self, tmp_path, fmt):
        rows = np.zeros((3, len(REQUIRED)), dtype=np.float32)
        assert code_of(lambda: read_header(write_custom_ply(tmp_path / "f.ply", rows, REQUIRED, fmt=fmt))) == ("master_invalid", 422)

    @pytest.mark.parametrize("missing", REQUIRED)
    def test_rejects_a_file_that_is_not_a_gaussian_splat(self, tmp_path, missing):
        properties = [name for name in REQUIRED if name != missing]
        rows = np.zeros((3, len(properties)), dtype=np.float32)
        code, status = code_of(lambda: read_header(write_custom_ply(tmp_path / "m.ply", rows, properties)))
        assert (code, status) == ("master_invalid", 422)

    def test_rejects_a_truncated_file(self, master):
        data = master.read_bytes()
        master.write_bytes(data[:-1])
        assert code_of(lambda: read_header(master)) == ("master_invalid", 422)

    def test_rejects_trailing_data(self, master):
        master.write_bytes(master.read_bytes() + b"\x00")
        assert code_of(lambda: read_header(master)) == ("master_invalid", 422)

    def test_rejects_an_empty_scene(self, tmp_path):
        rows = np.zeros((0, len(REQUIRED)), dtype=np.float32)
        assert code_of(lambda: read_header(write_custom_ply(tmp_path / "e.ply", rows, REQUIRED))) == ("master_invalid", 422)

    def test_rejects_a_vertex_count_that_is_not_a_number(self, tmp_path):
        path = tmp_path / "n.ply"
        path.write_bytes(b"ply\nformat binary_little_endian 1.0\nelement vertex lots\nproperty float x\nend_header\n")
        assert code_of(lambda: read_header(path)) == ("master_invalid", 422)

    def test_rejects_a_property_type_it_cannot_read(self, tmp_path):
        path = tmp_path / "t.ply"
        path.write_bytes(b"ply\nformat binary_little_endian 1.0\nelement vertex 1\nproperty list uchar int x\nend_header\n")
        assert code_of(lambda: read_header(path)) == ("master_invalid", 422)

    def test_rejects_elements_after_the_vertices(self, tmp_path):
        rows = np.zeros((2, len(REQUIRED)), dtype=np.float32)
        path = tmp_path / "x.ply"
        text = "ply\nformat binary_little_endian 1.0\nelement vertex 2\n" + "".join(f"property float {n}\n" for n in REQUIRED) + "element face 0\nproperty uchar x\nend_header\n"
        path.write_bytes(text.encode() + rows.tobytes())
        assert code_of(lambda: read_header(path)) == ("master_invalid", 422)

    def test_does_not_read_past_a_header_that_never_ends(self, tmp_path):
        path = tmp_path / "h.ply"
        path.write_bytes(b"ply\nformat binary_little_endian 1.0\n" + b"comment " + b"x" * 70_000)
        assert code_of(lambda: read_header(path)) == ("master_invalid", 422)


class TestReducedPly:
    def row(self, opacity: float, scale: float, x: float = 0.0) -> np.ndarray:
        values = {name: 0.0 for name in PROPERTIES}
        values.update({"x": x, "opacity": opacity, "scale_0": scale, "scale_1": scale, "scale_2": scale, "rot_0": 1.0})
        return np.array([values[name] for name in PROPERTIES], dtype=np.float32)

    def build(self, tmp_path, rows) -> "pathlib.Path":
        path = tmp_path / "scene.ply"
        write_ply(path, np.stack(rows))
        return path

    def test_keeps_the_splats_that_carry_the_picture_in_their_original_order(self, tmp_path):
        # importance = sigmoid(opacity) * exp(sum of log scales)
        rows = [self.row(0.0, -3.0, 0), self.row(4.0, -1.0, 1), self.row(-4.0, -1.0, 2), self.row(4.0, -1.0, 3), self.row(0.0, -1.0, 4), self.row(4.0, -3.0, 5)]
        source = self.build(tmp_path, rows)
        total, kept = write_reduced_ply(source, tmp_path / "out.ply", 3)
        assert (total, kept) == (6, 3)
        out = read_header(tmp_path / "out.ply")
        data = np.memmap(tmp_path / "out.ply", dtype=out.dtype(), mode="r", offset=out.data_offset, shape=(out.vertex_count,))
        # Most important: x=1 and x=3 (opaque and large), then x=4 (large, half opaque). Order is preserved.
        assert list(data["x"]) == [1.0, 3.0, 4.0]

    def test_breaks_ties_towards_the_lower_row(self, tmp_path):
        rows = [self.row(2.0, -2.0, index) for index in range(8)]
        source = self.build(tmp_path, rows)
        write_reduced_ply(source, tmp_path / "out.ply", 3)
        out = read_header(tmp_path / "out.ply")
        data = np.memmap(tmp_path / "out.ply", dtype=out.dtype(), mode="r", offset=out.data_offset, shape=(3,))
        assert list(data["x"]) == [0.0, 1.0, 2.0]

    def test_is_reproducible_byte_for_byte(self, master, tmp_path):
        write_reduced_ply(master, tmp_path / "a.ply", 700)
        write_reduced_ply(master, tmp_path / "b.ply", 700)
        assert (tmp_path / "a.ply").read_bytes() == (tmp_path / "b.ply").read_bytes()

    def test_gives_the_same_answer_however_it_is_chunked(self, master, tmp_path):
        write_reduced_ply(master, tmp_path / "big.ply", 700, chunk_rows=1_000_000)
        write_reduced_ply(master, tmp_path / "small.ply", 700, chunk_rows=7)
        assert (tmp_path / "big.ply").read_bytes() == (tmp_path / "small.ply").read_bytes()

    def test_drops_spherical_harmonics_and_keeps_every_other_value_exactly(self, master, tmp_path):
        total, kept = write_reduced_ply(master, tmp_path / "out.ply", total_keep := 3000)
        assert (total, kept) == (3000, total_keep)
        out = read_header(tmp_path / "out.ply")
        names = [name for name, _ in out.properties]
        assert not any(name.startswith("f_rest_") for name in names)
        assert names == [name for name in PROPERTIES if not name.startswith("f_rest_")]
        src_header = read_header(master)
        src = np.memmap(master, dtype=src_header.dtype(), mode="r", offset=src_header.data_offset, shape=(src_header.vertex_count,))
        dst = np.memmap(tmp_path / "out.ply", dtype=out.dtype(), mode="r", offset=out.data_offset, shape=(out.vertex_count,))
        for name in names:
            assert np.array_equal(src[name], dst[name]), name

    def test_can_keep_the_spherical_harmonics_when_asked(self, master, tmp_path):
        write_reduced_ply(master, tmp_path / "out.ply", 500, drop_sh=False)
        assert [name for name, _ in read_header(tmp_path / "out.ply").properties] == PROPERTIES

    def test_asking_for_more_than_there_is_keeps_everything(self, master, tmp_path):
        assert write_reduced_ply(master, tmp_path / "out.ply", 10_000) == (3000, 3000)

    def test_output_is_a_valid_splat_ply_of_the_requested_size(self, master, tmp_path):
        write_reduced_ply(master, tmp_path / "out.ply", 1234)
        assert splat_count(tmp_path / "out.ply") == 1234

    @pytest.mark.parametrize("keep", [0, -1])
    def test_refuses_a_target_that_is_not_positive(self, master, tmp_path, keep):
        assert code_of(lambda: write_reduced_ply(master, tmp_path / "o.ply", keep)) == ("preview_invalid_target", 422)


class TestSyntheticFixture:
    def test_is_deterministic_and_seed_sensitive(self):
        assert np.array_equal(synthesize(500, 1), synthesize(500, 1))
        assert not np.array_equal(synthesize(500, 1), synthesize(500, 2))

    def test_refuses_an_empty_scene(self):
        with pytest.raises(ValueError):
            synthesize(0, 1)

    def test_covers_the_scene_it_documents(self):
        rows = synthesize(20_000, 3)
        y = rows[:, 1]
        assert y.min() >= -0.51 and y.max() <= 0.95
        assert abs(rows[:, 0]).max() <= 2.01
