"""Full render derivative and lightweight preview of a trained splat: byte-exactness, budget, order, typed failures."""
import math
import pathlib
import tempfile
import unittest

import numpy as np

import splat_variants as sv
from video_pipeline import WorkerError

NERF_PROPERTIES = (
    ["x", "y", "z", "nx", "ny", "nz", "f_dc_0", "f_dc_1", "f_dc_2"]
    + [f"f_rest_{index}" for index in range(45)]
    + ["opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"]
)
NL = chr(10)


def header_for(count, names, fmt="binary_little_endian 1.0", kind="float"):
    lines = ["ply", f"format {fmt}", f"element vertex {count}", *[f"property {kind} {name}" for name in names], "end_header"]
    return (NL.join(lines) + NL).encode("ascii")


def make_rows(count, names=NERF_PROPERTIES, seed=7, zero_normals=True):
    generator = np.random.default_rng(seed)
    rows = generator.normal(size=(count, len(names))).astype("<f4")
    if zero_normals:
        for name in ("nx", "ny", "nz"):
            if name in names:
                rows[:, names.index(name)] = 0.0
    return rows


def write_ply(path, rows, names=NERF_PROPERTIES):
    path.write_bytes(header_for(len(rows), names) + np.ascontiguousarray(rows, dtype="<f4").tobytes())
    return path


def read_ply(path):
    data = path.read_bytes()
    marker = b"end_header" + NL.encode()
    end = data.index(marker) + len(marker)
    lines = data[:end].decode("ascii").split(NL)
    count = int(next(line for line in lines if line.startswith("element vertex")).split()[2])
    names = [line.split()[2] for line in lines if line.startswith("property")]
    rows = np.frombuffer(data[end:], dtype="<f4").reshape(count, len(names))
    return data[:end], names, rows


def reference_importance(row, names):
    opacity = row[names.index("opacity")]
    scales = sorted(float(row[names.index(f"scale_{axis}")]) for axis in range(3))
    return (1.0 / (1.0 + math.exp(-float(opacity)))) * math.exp(scales[1] + scales[2])


class SplatVariantTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.output = self.root / "output"
        self.output.mkdir()

    def raw(self, rows, names=NERF_PROPERTIES):
        return write_ply(self.root / "splat.ply", rows, names)

    # -- full render derivative ------------------------------------------------------------------

    def test_full_derivative_is_byte_exact_except_dropped_zero_normals(self):
        rows = make_rows(64)
        result = sv.convert_export(self.raw(rows), self.output, budget_bytes=10 ** 9)
        header, names, derived = read_ply(self.output / "render" / "reconstruction.ply")
        kept = [name for name in NERF_PROPERTIES if name not in ("nx", "ny", "nz")]
        self.assertEqual(names, kept)
        self.assertEqual(header, header_for(64, kept))
        columns = [NERF_PROPERTIES.index(name) for name in kept]
        self.assertEqual(derived.tobytes(), np.ascontiguousarray(rows[:, columns]).tobytes())
        self.assertTrue(result["full"]["droppedNormals"])
        self.assertEqual(result["full"]["splats"], 64)

    def test_full_derivative_keeps_all_sh_rest_coefficients(self):
        sv.convert_export(self.raw(make_rows(8)), self.output, budget_bytes=10 ** 9)
        _, names, _ = read_ply(self.output / "render" / "reconstruction.ply")
        self.assertEqual([name for name in names if name.startswith("f_rest_")], [f"f_rest_{index}" for index in range(45)])

    def test_normals_are_not_dropped_when_any_is_non_zero(self):
        rows = make_rows(40)
        rows[31, NERF_PROPERTIES.index("ny")] = np.float32(1e-7)
        raw = self.raw(rows)
        result = sv.convert_export(raw, self.output, budget_bytes=10 ** 9)
        self.assertFalse(result["full"]["droppedNormals"])
        self.assertEqual((self.output / "render" / "reconstruction.ply").read_bytes(), raw.read_bytes())

    def test_normals_are_not_dropped_when_only_the_last_row_is_non_zero(self):
        rows = make_rows(10)
        rows[9, NERF_PROPERTIES.index("nz")] = np.float32(-2.0)
        result = sv.convert_export(self.raw(rows), self.output, budget_bytes=10 ** 9)
        self.assertFalse(result["full"]["droppedNormals"])

    def test_input_without_normals_is_copied_value_for_value(self):
        names = [name for name in NERF_PROPERTIES if name not in ("nx", "ny", "nz")]
        raw = self.raw(make_rows(12, names), names)
        sv.convert_export(raw, self.output, budget_bytes=10 ** 9)
        self.assertEqual((self.output / "render" / "reconstruction.ply").read_bytes(), raw.read_bytes())

    # -- lightweight -----------------------------------------------------------------------------

    def test_no_lightweight_when_the_full_file_fits_the_budget(self):
        result = sv.convert_export(self.raw(make_rows(30)), self.output, budget_bytes=10 ** 9)
        self.assertIsNone(result["lightweight"])
        self.assertEqual([item["role"] for item in result["variants"]], ["spatial_mobile"])
        self.assertFalse((self.output / "render" / "reconstruction-light.ply").exists())

    def test_no_lightweight_when_the_full_file_is_exactly_the_budget(self):
        kept = [name for name in NERF_PROPERTIES if name not in ("nx", "ny", "nz")]
        full = len(header_for(30, kept)) + 30 * 4 * len(kept)
        result = sv.convert_export(self.raw(make_rows(30)), self.output, budget_bytes=full)
        self.assertIsNone(result["lightweight"])
        result = sv.convert_export(self.raw(make_rows(30)), self.output, budget_bytes=full - 1)
        self.assertIsNotNone(result["lightweight"])

    def test_lightweight_header_and_property_set_are_exact(self):
        result = sv.convert_export(self.raw(make_rows(300)), self.output, budget_bytes=6000)
        header, names, light = read_ply(self.output / "render" / "reconstruction-light.ply")
        self.assertEqual(names, list(sv.LIGHTWEIGHT_PROPERTIES))
        self.assertEqual(
            list(sv.LIGHTWEIGHT_PROPERTIES),
            ["x", "y", "z", "f_dc_0", "f_dc_1", "f_dc_2", "opacity", "scale_0", "scale_1", "scale_2", "rot_0", "rot_1", "rot_2", "rot_3"],
        )
        self.assertEqual(header, header_for(len(light), sv.LIGHTWEIGHT_PROPERTIES))
        self.assertEqual(light.shape[1] * 4, 56)
        self.assertEqual([item["role"] for item in result["variants"]], ["spatial_mobile", "spatial_preview"])
        self.assertEqual(result["lightweight"], {
            "method": "sh0-importance-prune/1", "sourceSplats": 300, "keptSplats": len(light), "shDegree": 0, "budgetBytes": 6000,
        })

    def test_lightweight_fits_the_budget_and_keeps_the_maximal_count(self):
        rows = make_rows(500)
        for budget in (4000, 5000, 5617, 9999, 12345):
            with self.subTest(budget=budget):
                sv.convert_export(self.raw(rows), self.output, budget_bytes=budget)
                path = self.output / "render" / "reconstruction-light.ply"
                size = path.stat().st_size
                _, _, light = read_ply(path)
                self.assertLessEqual(size, budget)
                self.assertEqual(size, len(header_for(len(light), sv.LIGHTWEIGHT_PROPERTIES)) + 56 * len(light))
                # One more splat would no longer fit (its header may even be a digit longer).
                self.assertGreater(len(header_for(len(light) + 1, sv.LIGHTWEIGHT_PROPERTIES)) + 56 * (len(light) + 1), budget)

    def test_lightweight_count_is_maximal_across_a_header_digit_boundary(self):
        for kept in (9, 10, 99, 100):
            exact = len(header_for(kept, sv.LIGHTWEIGHT_PROPERTIES)) + 56 * kept
            self.assertEqual(sv.max_kept_splats(10_000, exact), kept)
            self.assertEqual(sv.max_kept_splats(10_000, exact - 1), kept - 1)

    def test_lightweight_keeps_the_most_important_splats_in_original_order(self):
        rows = make_rows(400, seed=11)
        sv.convert_export(self.raw(rows), self.output, budget_bytes=8000)
        _, _, light = read_ply(self.output / "render" / "reconstruction-light.ply")
        scored = sorted(range(len(rows)), key=lambda index: (-reference_importance(rows[index], NERF_PROPERTIES), index))
        expected = sorted(scored[:len(light)])
        columns = [NERF_PROPERTIES.index(name) for name in sv.LIGHTWEIGHT_PROPERTIES]
        self.assertEqual(light.tobytes(), np.ascontiguousarray(rows[expected][:, columns]).tobytes())

    def test_importance_uses_the_two_largest_scales_and_sigmoid_opacity(self):
        names = list(sv.LIGHTWEIGHT_PROPERTIES)
        rows = np.zeros((3, len(names)), dtype="<f4")
        scale = [names.index(f"scale_{axis}") for axis in range(3)]
        rows[:, names.index("opacity")] = [0.0, 0.0, 4.0]
        rows[0, scale] = [1.0, 2.0, 3.0]      # the two largest sum to 5
        rows[1, scale] = [3.0, 2.0, 1.0]      # the same set in another order: the same score
        rows[2, scale] = [-9.0, -9.0, -9.0]   # tiny scale, big opacity
        score = sv.importance(rows[:, names.index("opacity")], rows[:, scale])
        self.assertAlmostEqual(score[0], 0.5 * math.exp(5.0), places=6)
        self.assertEqual(score[0], score[1])
        self.assertLess(score[2], score[0])

    def test_ties_keep_the_lowest_original_indices(self):
        rows = make_rows(300, seed=3)
        for name in ("opacity", "scale_0", "scale_1", "scale_2"):
            rows[:, NERF_PROPERTIES.index(name)] = 0.25  # every splat scores the same
        rows[:, NERF_PROPERTIES.index("x")] = np.arange(300, dtype="<f4")  # identifies the original index
        sv.convert_export(self.raw(rows), self.output, budget_bytes=6000)
        _, _, light = read_ply(self.output / "render" / "reconstruction-light.ply")
        self.assertEqual(light[:, 0].tolist(), [float(index) for index in range(len(light))])

    def test_non_finite_importance_ranks_last(self):
        rows = make_rows(300, seed=5)
        rows[0, NERF_PROPERTIES.index("opacity")] = np.float32("nan")
        rows[1, NERF_PROPERTIES.index("scale_0")] = np.float32("inf")
        rows[1, NERF_PROPERTIES.index("scale_1")] = np.float32("inf")
        rows[:, NERF_PROPERTIES.index("x")] = np.arange(300, dtype="<f4")
        sv.convert_export(self.raw(rows), self.output, budget_bytes=6000)
        _, _, light = read_ply(self.output / "render" / "reconstruction-light.ply")
        self.assertNotIn(0.0, light[:, 0].tolist())
        self.assertNotIn(1.0, light[:, 0].tolist())

    def test_the_raw_export_is_never_copied_into_the_output(self):
        raw = self.raw(make_rows(300))
        sv.convert_export(raw, self.output, budget_bytes=6000)
        for produced in (self.output / "render").iterdir():
            self.assertNotEqual(produced.read_bytes(), raw.read_bytes())
            self.assertFalse(produced.name.endswith(".tmp"))

    # -- budget ----------------------------------------------------------------------------------

    def test_budget_default_and_clamp(self):
        self.assertEqual(sv.lightweight_budget({}), 20 * 1024 * 1024)
        self.assertEqual(sv.lightweight_budget({sv.BUDGET_ENV: "5000000"}), 5_000_000)
        self.assertEqual(sv.lightweight_budget({sv.BUDGET_ENV: "10"}), 1024 * 1024)
        self.assertEqual(sv.lightweight_budget({sv.BUDGET_ENV: str(10 ** 12)}), 20 * 1024 * 1024)
        self.assertEqual(sv.lightweight_budget({sv.BUDGET_ENV: "banana"}), 20 * 1024 * 1024)

    # -- typed failures --------------------------------------------------------------------------

    def assert_conversion_failure(self, raw, budget_bytes=6000):
        with self.assertRaises(WorkerError) as caught:
            sv.convert_export(raw, self.output, budget_bytes=budget_bytes)
        self.assertEqual(caught.exception.code, "output_conversion_failed")
        self.assertEqual(caught.exception.detail()["code"], "output_conversion_failed")

    def test_malformed_inputs_fail_with_the_typed_code(self):
        good = header_for(4, NERF_PROPERTIES) + make_rows(4).tobytes()
        base = "ply" + NL + "format binary_little_endian 1.0" + NL
        cases = {
            "truncated body": good[:-12],
            "trailing bytes": good + b"\x00\x00\x00\x00",
            "not a ply": b"solid" + NL.encode() + b"\x00" * 4096,
            "no end_header": (base).encode() + b"\x00" * 100,
            "ascii format": header_for(1, ["x"], fmt="ascii 1.0") + b"1.0" + NL.encode(),
            "big endian": header_for(1, ["x"], fmt="binary_big_endian 1.0") + b"\x00" * 4,
            "double property": header_for(1, ["x"], kind="double") + b"\x00" * 8,
            "zero vertices": header_for(0, ["x"]),
            "duplicate property": header_for(1, ["x", "x"]) + b"\x00" * 8,
            "second element": (base + "element vertex 1" + NL + "property float x" + NL + "element face 1" + NL + "end_header" + NL).encode() + b"\x00" * 4,
            "list property": (base + "element vertex 1" + NL + "property list uchar int x" + NL + "end_header" + NL).encode() + b"\x00" * 4,
        }
        for label, data in cases.items():
            with self.subTest(label):
                raw = self.root / "bad.ply"
                raw.write_bytes(data)
                self.assert_conversion_failure(raw)

    def test_missing_file_fails_with_the_typed_code(self):
        self.assert_conversion_failure(self.root / "absent.ply")

    def test_missing_lightweight_property_fails_with_the_typed_code(self):
        names = [name for name in NERF_PROPERTIES if name != "rot_3"]
        self.assert_conversion_failure(self.raw(make_rows(300, names), names))

    def test_a_budget_that_cannot_hold_one_splat_fails_with_the_typed_code(self):
        self.assert_conversion_failure(self.raw(make_rows(300)), budget_bytes=100)

    def test_a_failed_conversion_leaves_no_partial_file(self):
        names = [name for name in NERF_PROPERTIES if name != "rot_3"]
        with self.assertRaises(WorkerError):
            sv.convert_export(self.raw(make_rows(300, names), names), self.output, budget_bytes=6000)
        self.assertEqual([item.name for item in (self.output / "render").glob("*.tmp")], [])


if __name__ == "__main__":
    unittest.main()
