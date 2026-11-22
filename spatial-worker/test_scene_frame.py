"""Viewer orientation and floater crop tests. Pure numpy; no GPU, COLMAP or Nerfstudio needed."""
import json
import math
import pathlib
import tempfile
import unittest

import numpy as np

import scene_frame as sf


def camera(position, target, up):
    """OpenGL camera-to-world matrix: +Y is the image up axis, the camera looks along -Z."""
    position, target, up = (np.asarray(v, dtype=float) for v in (position, target, up))
    back = position - target
    back /= np.linalg.norm(back)
    right = np.cross(up, back)
    right /= np.linalg.norm(right)
    true_up = np.cross(back, right)
    matrix = np.eye(4)
    matrix[:3, 0], matrix[:3, 1], matrix[:3, 2], matrix[:3, 3] = right, true_up, back, position
    return matrix


def orbit(count=24, radius=2.0, height=1.0, start=0.0, span=2 * math.pi, up=(0, 0, 1)):
    poses = []
    for index in range(count):
        angle = start + span * index / max(count - 1, 1) if span < 2 * math.pi else start + span * index / count
        poses.append(camera((radius * math.cos(angle), radius * math.sin(angle), height), (0, 0, 0.3), up))
    return np.stack(poses)


def rotation_about(axis, angle):
    axis = np.asarray(axis, dtype=float)
    axis /= np.linalg.norm(axis)
    skew = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + math.sin(angle) * skew + (1 - math.cos(angle)) * skew @ skew


def rotate_world(poses, points, rotation):
    full = np.eye(4)
    full[:3, :3] = rotation
    return np.einsum("ij,njk->nik", full, poses), points @ rotation.T


def apply(matrix, point):
    return (matrix @ np.append(point, 1.0))[:3]


class OrientationTests(unittest.TestCase):
    def test_up_is_the_mean_camera_up_in_any_world_orientation(self):
        poses = orbit()
        points = np.random.default_rng(1).normal(size=(300, 3)) * 0.3
        for axis, angle in (((1, 0, 0), 1.1), ((1, 2, 3), 2.5), ((0, 1, 0), -0.7)):
            rotation = rotation_about(axis, angle)
            rotated_poses, _ = rotate_world(poses, points, rotation)
            estimate = sf.estimate_up(rotated_poses)
            self.assertEqual(estimate["method"], "camera_up")
            expected = rotation @ np.array([0.0, 0.0, 1.0])
            # Cameras tilt down to the subject, so the mean up is close to, not exactly, the world up.
            self.assertGreater(float(np.dot(estimate["up"], expected)), 0.97)

    def test_the_viewer_matrix_puts_up_on_plus_y_with_a_proper_rotation(self):
        up = np.array([0.3, -0.5, 0.8])
        up /= np.linalg.norm(up)
        matrix = sf.viewer_matrix(up, None, np.array([1.0, 2.0, 3.0]), 4.0)
        linear = matrix[:3, :3]
        scale = 2.0 / 4.0
        self.assertAlmostEqual(float(np.linalg.det(linear / scale)), 1.0, places=6)  # a rotation, never a mirror
        mapped = linear @ up
        np.testing.assert_allclose(mapped / np.linalg.norm(mapped), [0, 1, 0], atol=1e-9)
        np.testing.assert_allclose(apply(matrix, [1.0, 2.0, 3.0]), [0, 0, 0], atol=1e-9)

    def test_an_upside_down_scene_is_turned_over(self):
        matrix = sf.viewer_matrix(np.array([0.0, -1.0, 0.0]), None, np.zeros(3), 2.0)
        np.testing.assert_allclose(matrix[:3, :3] @ np.array([0, -1, 0.0]), [0, 1, 0], atol=1e-9)
        self.assertAlmostEqual(float(np.linalg.det(matrix[:3, :3])), 1.0, places=6)

    def test_a_one_sided_set_faces_the_viewer_camera(self):
        # Cameras cover only a 70 degree arc on the +X side of a z-up scene.
        poses = orbit(count=20, start=-0.6, span=1.2)
        points = np.random.default_rng(2).normal(size=(400, 3)) * 0.25
        result = sf.analyse_scene(poses, points)
        self.assertIsNotNone(result["orientation"]["front"])
        matrix = np.asarray(result["matrix"]).reshape(4, 4).T  # undo column-major
        toward_cameras = matrix[:3, :3] @ np.array(result["orientation"]["front"])
        np.testing.assert_allclose(toward_cameras / np.linalg.norm(toward_cameras), [0, 0, 1], atol=1e-4)
        # The viewer looks from +Z, so a camera position of the set lands on the +Z side of the origin.
        camera_in_viewer = apply(matrix, poses[len(poses) // 2][:3, 3])
        self.assertGreater(camera_in_viewer[2], 0.5)
        self.assertLess(abs(camera_in_viewer[1]), 3.0)

    def test_a_full_orbit_has_no_front_and_keeps_its_yaw(self):
        poses = orbit(count=36)
        self.assertIsNone(sf.estimate_front(poses, np.zeros(3), np.array([0.0, 0.0, 1.0])))

    def test_mixed_orientation_cameras_fall_back_to_the_plane_normal(self):
        # Half the cameras are rolled a quarter turn about their optical axis: the up axes cancel out.
        a, b = orbit(count=12), orbit(count=12)
        for index in range(len(b)):
            b[index][:3, :3] = b[index][:3, :3] @ rotation_about([0, 0, 1], math.pi / 2)
        poses = np.concatenate([a, b])
        rng = np.random.default_rng(3)
        flat = np.column_stack([rng.normal(size=500), rng.normal(size=500), rng.normal(size=500) * 0.01])  # a floor plane
        estimate = sf.estimate_up(poses, flat)
        self.assertLess(np.linalg.norm(poses[:, :3, 1].mean(axis=0)), sf.MIN_UP_CONFIDENCE)
        self.assertEqual(estimate["method"], "plane_normal")
        self.assertAlmostEqual(abs(float(estimate["up"][2])), 1.0, places=2)
        # A heuristic answer: usable, but never reported as trusted.
        self.assertLess(estimate["confidence"], sf.MIN_UP_CONFIDENCE)
        analysis = sf.analyse_scene(poses, flat)
        self.assertFalse(analysis["orientation"]["trusted"])

    def test_a_wall_seen_face_on_is_not_given_a_sideways_up_by_the_plane_fallback(self):
        # A mural: sparse points on the wall x = 0 (its normal is horizontal), cameras facing it from x = 3
        # with their roll spread over three angles (0, 120 and 240 degrees), so the camera ups cancel out.
        rng = np.random.default_rng(5)
        wall = np.column_stack([rng.normal(size=600) * 0.01, rng.normal(size=600), rng.normal(size=600)])
        poses = []
        for index in range(24):
            offset = rng.normal(size=2) * 0.3
            pose = camera((3.0, offset[0], offset[1]), (0.0, 0.0, 0.0), (0, 0, 1))
            pose[:3, :3] = pose[:3, :3] @ rotation_about([0, 0, 1], (index % 3) * 2 * math.pi / 3)
            poses.append(pose)
        poses = np.stack(poses)
        self.assertLess(np.linalg.norm(poses[:, :3, 1].mean(axis=0)), sf.MIN_UP_CONFIDENCE)
        plane, flatness = sf.plane_normal(wall)
        self.assertGreater(abs(float(plane[0])), 0.99)  # the dominant plane is the wall, normal along x
        self.assertGreater(flatness, 0.9)
        estimate = sf.estimate_up(poses, wall)
        self.assertNotEqual(estimate["method"], "plane_normal")
        self.assertLess(estimate["confidence"], sf.MIN_UP_CONFIDENCE)  # never reported as a trusted answer

    def test_an_obliquely_photographed_wall_is_never_a_trusted_plane_answer(self):
        # The review-2 case: a wall mural (points on x = 0) shot from a spread of azimuths up to 70 degrees either
        # side with random roll. Those cameras are no longer face-on, so the plane fallback applies, and its
        # "up" is the wall normal (sideways). View geometry cannot tell this from a floor, so the answer must
        # be reported as a low-confidence heuristic, not as a trusted one.
        rng = np.random.default_rng(11)
        wall = np.column_stack([rng.normal(size=800) * 0.005, rng.normal(size=800), rng.normal(size=800)])
        for spread in (30.0, 50.0, 70.0):
            poses = []
            for _ in range(30):
                azimuth = math.radians(rng.uniform(-spread, spread))
                position = (3.0 * math.cos(azimuth), 3.0 * math.sin(azimuth), rng.normal() * 0.2)
                pose = camera(position, (0.0, 0.0, 0.0), (0, 0, 1))
                pose[:3, :3] = pose[:3, :3] @ rotation_about([0, 0, 1], rng.uniform(0.0, 2 * math.pi))
                poses.append(pose)
            poses = np.stack(poses)
            estimate = sf.estimate_up(poses, wall)
            self.assertLess(estimate["confidence"], sf.MIN_UP_CONFIDENCE, f"spread {spread}")
            analysis = sf.analyse_scene(poses, wall)
            self.assertFalse(analysis["orientation"]["trusted"], f"spread {spread}")
            self.assertLess(analysis["orientation"]["confidence"], sf.MIN_UP_CONFIDENCE)

    def test_a_consensus_of_camera_ups_is_trusted(self):
        poses = orbit(count=24)
        analysis = sf.analyse_scene(poses, np.random.default_rng(2).normal(size=(300, 3)))
        self.assertEqual(analysis["orientation"]["method"], "camera_up")
        self.assertTrue(analysis["orientation"]["trusted"])

    def test_with_nothing_to_go_on_up_is_assumed(self):
        poses = np.stack([np.eye(4), np.eye(4)])
        poses[1][:3, :3] = np.diag([1, -1, -1])
        estimate = sf.estimate_up(poses)
        self.assertEqual(estimate["method"], "assumed")


class CropTests(unittest.TestCase):
    def test_the_box_keeps_the_subject_and_drops_far_outliers(self):
        rng = np.random.default_rng(4)
        subject = rng.uniform(-1, 1, size=(2000, 3))
        floaters = np.array([[30, 0, 0], [0, -25, 4], [0, 0, 40], [-33, 12, 3], [9, 9, 60.0]])
        low, high = sf.crop_box(np.concatenate([subject, floaters]))
        inside = lambda p: bool(np.all(p >= low) and np.all(p <= high))
        self.assertTrue(all(inside(p) for p in subject[:200]))
        self.assertFalse(any(inside(p) for p in floaters))
        self.assertLess(float((high - low).max()), 6.0)

    def test_a_flat_subject_is_not_cut_to_a_sliver(self):
        rng = np.random.default_rng(5)
        wall = np.column_stack([rng.uniform(-2, 2, 1500), rng.uniform(-1.5, 1.5, 1500), rng.normal(size=1500) * 0.002])
        low, high = sf.crop_box(wall)
        extent = high - low
        self.assertGreater(float(extent[2]), 0.1 * float(extent.max()))

    def test_the_manifest_box_records_its_method(self):
        rng = np.random.default_rng(6)
        result = sf.analyse_scene(orbit(), rng.normal(size=(500, 3)) * 0.3)
        box = result["box"]
        self.assertEqual(box["method"], "sparse_point_percentile")
        self.assertEqual(box["frame"], "splat")
        self.assertEqual(len(box["min"]), 3)
        self.assertTrue(all(lo < hi for lo, hi in zip(box["min"], box["max"])))

    def test_too_few_points_fall_back_to_the_camera_cloud_without_a_box(self):
        result = sf.analyse_scene(orbit(), np.zeros((3, 3)))
        self.assertNotIn("box", result)
        self.assertEqual(len(result["matrix"]), 16)
        self.assertTrue(all(math.isfinite(value) for value in result["matrix"]))


class FrameMappingTests(unittest.TestCase):
    def test_the_dataparser_transform_moves_cameras_and_points_like_nerfstudio(self):
        poses = orbit(count=3)
        points = np.array([[1.0, 0.0, 0.0], [0.0, 2.0, 0.0]])
        rotation = rotation_about([0, 0, 1], math.pi / 2)
        transform = np.column_stack([rotation, [0.5, 0.0, 0.0]])
        mapped_poses, mapped_points = sf.to_training_frame(poses, points, transform, 0.1)
        np.testing.assert_allclose(mapped_points[0], (rotation @ points[0] + [0.5, 0, 0]) * 0.1)
        np.testing.assert_allclose(mapped_poses[0][:3, 3], (rotation @ poses[0][:3, 3] + [0.5, 0, 0]) * 0.1)
        np.testing.assert_allclose(mapped_poses[0][:3, 1], rotation @ poses[0][:3, 1])  # directions are not scaled

    def test_the_applied_transform_baked_into_transforms_json_is_undone_first(self):
        # Nerfstudio's dataparser transform maps the RAW COLMAP world to the training frame, with
        # transforms.json's applied_transform folded in; transforms.json cameras already carry it.
        applied = np.array([[1.0, 0, 0, 0], [0, 0, 1.0, 0], [0, -1.0, 0, 0]])
        applied4 = np.vstack([applied, [0, 0, 0, 1]])
        raw = orbit(count=6, up=(0, 0, 1))
        in_transforms_frame = np.einsum("ij,njk->nik", applied4, raw)
        extra = rotation_about([0, 0, 1], 0.4)
        total = np.hstack([extra, np.zeros((3, 1))]) @ applied4  # what ns-train writes: extra @ applied
        points = np.array([[1.0, 2.0, 3.0]])
        mapped, mapped_points = sf.to_training_frame(in_transforms_frame, points, total, 1.0, applied)
        # The result is the transforms.json frame turned by `extra` only; `applied` must not be applied twice.
        np.testing.assert_allclose(mapped[:, :3, 3], in_transforms_frame[:, :3, 3] @ extra.T, atol=1e-9)
        np.testing.assert_allclose(mapped[:, :3, 1], in_transforms_frame[:, :3, 1] @ extra.T, atol=1e-9)
        np.testing.assert_allclose(mapped_points[0], extra @ points[0], atol=1e-9)
        wrong, _ = sf.to_training_frame(in_transforms_frame, points, total, 1.0, None)
        self.assertFalse(np.allclose(wrong[:, :3, 3], mapped[:, :3, 3]))

    def test_matrix_is_column_major_for_three_js(self):
        matrix = np.eye(4)
        matrix[:3, 3] = [7, 8, 9]
        flat = sf.column_major(matrix)
        self.assertEqual(flat[12:15], [7.0, 8.0, 9.0])
        self.assertEqual(flat[15], 1.0)

    def test_a_dataset_on_disk_is_analysed_end_to_end(self):
        with tempfile.TemporaryDirectory() as name:
            root = pathlib.Path(name)
            poses = orbit(count=30)
            (root / "transforms.json").write_text(json.dumps({"frames": [{"transform_matrix": pose.tolist()} for pose in poses]}))
            points = np.random.default_rng(7).normal(size=(200, 3)) * 0.4
            (root / "sparse_pc.ply").write_text(
                "ply\nformat ascii 1.0\nelement vertex 200\nproperty float x\nproperty float y\nproperty float z\nend_header\n"
                + "".join(f"{x} {y} {z} 1 2 3\n" for x, y, z in points)
            )
            (root / "dataparser_transforms.json").write_text(json.dumps({"transform": np.eye(4)[:3].tolist(), "scale": 1.0}))
            result = sf.analyse_dataset(root / "transforms.json", root / "sparse_pc.ply", root / "dataparser_transforms.json")
            self.assertEqual(result["orientation"]["method"], "camera_up")
            self.assertEqual(result["orientation"]["points"], 200)
            self.assertIn("box", result)
            self.assertGreater(result["up"][2], 0.9)


if __name__ == "__main__":
    unittest.main()
