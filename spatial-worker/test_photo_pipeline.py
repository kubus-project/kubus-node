"""Photo-set intake tests. COLMAP, ffmpeg and ffprobe are fakes; Pillow, OpenCV and NumPy are real."""
import json
import pathlib
import struct
import tempfile
import unittest
import unittest.mock
from unittest import mock

import cv2
import numpy as np
from PIL import Image

import photo_pipeline as pp
import video_pipeline as vp
from test_video_pipeline import FakeTools, completed, probe_json


def write_jpeg(path, size=(640, 480), orientation=None, make="Apple", model="iPhone 16 Pro", corner=None, seed=0):
    image = Image.fromarray(np.random.default_rng(seed).integers(0, 255, size=(size[1], size[0], 3), dtype=np.uint8))
    if corner:
        image.paste(corner, (0, 0, 16, 16))
    exif = Image.Exif()
    exif[0x010F], exif[0x0110] = make, model
    if orientation:
        exif[0x0112] = orientation
    exif[0x8769] = {0xA405: 26}
    image.save(path, "JPEG", quality=92, exif=exif.tobytes())


def make_photo_capture(root, count=30, **kwargs):
    capture = pathlib.Path(root) / "capture"
    (capture / "photos").mkdir(parents=True)
    for index in range(count):
        write_jpeg(capture / "photos" / f"IMG_{index + 1}.jpg", seed=index, **kwargs)
    return capture


class FakeColmap:
    """Stands in for colmap: records stages and writes a binary-model-shaped result."""

    def __init__(self, registered=None, returncode=0, fail_stage=None, models=1):
        self.calls = []
        self.registered = registered
        self.returncode = returncode
        self.fail_stage = fail_stage
        self.models = models

    def __call__(self, command, timeout):
        self.calls.append(list(command))
        if command[0] != "colmap":
            raise AssertionError(command)
        stage = command[1]
        if stage == "-h":
            return completed(command, 0, "COLMAP 3.9.1 -- Structure-from-Motion and Multi-View Stereo\n")
        if self.fail_stage == stage:
            return completed(command, 1, "", "CUDA error")
        if stage == "mapper":
            sparse = pathlib.Path(command[command.index("--output_path") + 1])
            images = pathlib.Path(command[command.index("--image_path") + 1])
            total = len(list(images.glob("*.jpg")))
            count = total if self.registered is None else self.registered
            for index in range(self.models):
                model = sparse / str(index)
                model.mkdir(parents=True)
                (model / "images.bin").write_bytes(struct.pack("<Q", count if index == 0 else 3))
                (model / "cameras.bin").write_bytes(struct.pack("<Q", 2))
        return completed(command, 0, "")


def fake_convert(registered_names):
    def convert(model, dataset):
        names = registered_names(dataset)
        (dataset / "transforms.json").write_text(json.dumps({
            "ply_file_path": "sparse_pc.ply",
            "frames": [{"file_path": f"./images/{name}"} for name in names],
        }))
        (dataset / "sparse_pc.ply").write_text("ply\nformat ascii 1.0\nelement vertex 1\nend_header\n0 0 0 1 1 1\n")
        return len(names)
    return convert


def first_n(count):
    def names(dataset):
        return sorted(path.name for path in (dataset / "images").glob("*.jpg"))[:count]
    return names


class PreparePhotoTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)

    def test_exif_orientation_is_baked_into_the_pixels_and_the_tag_is_gone(self):
        source, target = self.root / "a.jpg", self.root / "out.jpg"
        # Stored 400x300 with a red square at the top-left; orientation 6 means "rotate 90 degrees clockwise to display".
        write_jpeg(source, size=(400, 300), orientation=6, corner=(255, 0, 0))
        facts = pp.prepare_photo(source, target)
        self.assertTrue(facts["orientationApplied"])
        with Image.open(target) as result:
            self.assertEqual(result.size, (300, 400))
            self.assertIn(result.getexif().get(0x0112, 1), (None, 1))
            red, green, blue = result.convert("RGB").getpixel((290, 8))  # the stored top-left lands top-right
            self.assertGreater(red, 200)
            self.assertLess(green, 80)
            exif = result.getexif()
            self.assertEqual(exif.get(0x0110), "iPhone 16 Pro")  # lens facts kept as a focal prior
            self.assertEqual(exif.get_ifd(0x8769).get(0xA405), 26)

    def test_an_already_upright_photo_is_not_reported_as_rotated(self):
        write_jpeg(self.root / "a.jpg", size=(400, 300))
        facts = pp.prepare_photo(self.root / "a.jpg", self.root / "o.jpg")
        self.assertFalse(facts["orientationApplied"])
        self.assertEqual((facts["width"], facts["height"]), (400, 300))

    def test_large_photos_are_downscaled_to_the_long_side(self):
        write_jpeg(self.root / "big.jpg", size=(4000, 3000))
        facts = pp.prepare_photo(self.root / "big.jpg", self.root / "o.jpg", max_long_side=1000)
        self.assertEqual((facts["width"], facts["height"]), (1000, 750))
        self.assertEqual((facts["sourceWidth"], facts["sourceHeight"]), (4000, 3000))

    def test_the_pixel_limit_is_a_refusal_checked_before_decoding(self):
        write_jpeg(self.root / "a.jpg", size=(640, 480))
        decoded = []
        original_load = Image.Image.load

        def spying_load(image, *args, **kwargs):
            decoded.append(True)
            return original_load(image, *args, **kwargs)

        with mock.patch.object(pp, "MAX_PHOTO_PIXELS", 640 * 480 - 1), mock.patch.object(Image.Image, "load", spying_load):
            with self.assertRaises(ValueError):
                pp.prepare_photo(self.root / "a.jpg", self.root / "o.jpg")
        self.assertEqual(decoded, [])
        self.assertFalse((self.root / "o.jpg").exists())
        with mock.patch.object(pp, "MAX_PHOTO_PIXELS", 640 * 480):
            pp.prepare_photo(self.root / "a.jpg", self.root / "o.jpg")  # exactly at the limit is allowed
        self.assertIsNone(Image.MAX_IMAGE_PIXELS)  # Pillow's own bound would only warn up to 2x

    def test_unreadable_files_are_dropped_and_counted_and_names_become_constant(self):
        photos = []
        for index in range(3):
            path = self.root / f"weird name {index}\n.jpg"
            write_jpeg(path, seed=index)
            photos.append(path)
        broken = self.root / "broken.jpg"
        broken.write_bytes(b"\xff\xd8\xff\xe0 not really a jpeg")
        names, stats = pp.prepare_photos(photos[:1] + [broken] + photos[1:], self.root / "images")
        self.assertEqual(names, ["photo_00000.jpg", "photo_00001.jpg", "photo_00002.jpg"])
        self.assertEqual((stats["submitted"], stats["usable"], stats["unreadable"]), (4, 3, 1))
        self.assertEqual(stats["cameras"], {"Apple iPhone 16 Pro": 3})
        self.assertEqual(sorted(path.name for path in (self.root / "images").iterdir()), names)

    def test_find_photos_reads_only_regular_images_directly_under_photos_in_natural_order(self):
        capture = make_photo_capture(self.root, count=0)
        folder = capture / "photos"
        for name in ("IMG_10.jpg", "IMG_2.jpg", "IMG_1.JPG", "notes.txt", ".DS_Store"):
            (folder / name).write_bytes(b"x")
        (folder / "nested").mkdir()
        (folder / "nested" / "IMG_99.jpg").write_bytes(b"x")
        outside = self.root / "outside.jpg"
        outside.write_bytes(b"x")
        try:
            (folder / "link.jpg").symlink_to(outside)
        except OSError:
            pass
        self.assertEqual([path.name for path in pp.find_photos(capture)], ["IMG_1.JPG", "IMG_2.jpg", "IMG_10.jpg"])


class PhotoDatasetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.stages = []

    def progress(self, stage, detail):
        self.stages.append((stage, detail))

    def run_photos(self, capture, colmap, registered=None, include_video=False, tools=None):
        count = registered
        runner = tools if tools is not None else colmap
        return pp.prepare_photo_dataset(
            runner, capture, self.root / "work", self.progress, include_video=include_video,
            convert=fake_convert(first_n(count) if count is not None else first_n(10_000)),
        )

    def test_a_photo_set_is_prepared_solved_and_gated(self):
        capture = make_photo_capture(self.root, count=30)
        colmap = FakeColmap()
        result = self.run_photos(capture, colmap)
        self.assertEqual([stage for stage, _ in self.stages], ["preparing_photos", "solving_poses"])
        self.assertEqual(result["photos"]["usable"], 30)
        self.assertEqual(result["sfm"]["registeredViews"], 30)
        self.assertEqual(result["sfm"]["registeredPhotos"], 30)
        self.assertEqual(result["sfm"]["registeredVideoFrames"], 0)
        self.assertEqual(result["sfm"]["registrationRatio"], 1.0)
        self.assertTrue(result["sfm"]["sparsePointsInitialisation"])
        self.assertIn("COLMAP 3.9.1", result["sfm"]["toolVersion"])
        stages = [call[1] for call in colmap.calls if call[1] != "-h"]
        self.assertEqual(stages, ["feature_extractor", "exhaustive_matcher", "mapper"])
        extract = colmap.calls[0]
        self.assertEqual(extract[extract.index("--ImageReader.single_camera") + 1], "0")  # photos: cameras as COLMAP groups them
        self.assertEqual(extract[extract.index("--ImageReader.camera_model") + 1], "SIMPLE_RADIAL")
        self.assertEqual(sorted(path.name for path in (result["dataset"] / "images").glob("*.jpg"))[0], "photo_00000.jpg")

    def test_registered_view_floor_and_ratio_use_the_shared_gate_with_typed_errors(self):
        capture = make_photo_capture(self.root, count=30)
        with self.assertRaises(vp.WorkerError) as floor:
            self.run_photos(capture, FakeColmap(registered=20), registered=20)
        self.assertEqual(floor.exception.code, "sfm_failed")
        self.assertEqual(floor.exception.details["registeredViews"], 20)
        self.assertEqual(floor.exception.details["submittedViews"], 30)
        self.assertIn("at least 24", floor.exception.message)
        self.assertIn("20 of 30 images", floor.exception.message)
        # A big set that registers 26 of 60 passes the floor but not the ratio.
        big = make_photo_capture(self.root / "big", count=60)
        with self.assertRaises(vp.WorkerError) as ratio:
            pp.prepare_photo_dataset(FakeColmap(registered=26), big, self.root / "work2", self.progress, convert=fake_convert(first_n(26)))
        self.assertIn("43%", ratio.exception.message)

    def test_the_gate_in_force_is_recorded_and_a_lowered_floor_is_visible(self):
        capture = make_photo_capture(self.root, count=30)
        default = self.run_photos(capture, FakeColmap())["sfm"]
        self.assertEqual(default["minRegisteredViews"], vp.MIN_VIEWS_FOR_RECONSTRUCTION)
        self.assertEqual(default["minRegistrationRatio"], vp.MIN_REGISTRATION_RATIO)
        self.assertFalse(default["gateLowered"])
        small = make_photo_capture(self.root / "small", count=23)
        with mock.patch.object(pp, "PHOTO_MIN_REGISTERED_VIEWS", 20):
            lowered = pp.prepare_photo_dataset(
                FakeColmap(registered=22), small, self.root / "work3", self.progress, convert=fake_convert(first_n(22)))["sfm"]
        self.assertEqual((lowered["registeredViews"], lowered["submittedViews"]), (22, 23))
        self.assertEqual(lowered["minRegisteredViews"], 20)
        self.assertTrue(lowered["gateLowered"])
        with mock.patch.object(pp, "PHOTO_MIN_REGISTERED_VIEWS", 20), self.assertRaises(vp.WorkerError) as refused:
            pp.prepare_photo_dataset(
                FakeColmap(registered=19), make_photo_capture(self.root / "tiny", count=23), self.root / "work4", self.progress,
                convert=fake_convert(first_n(19)))
        self.assertEqual(refused.exception.details["minRegisteredViews"], 20)  # the refusal says which floor it applied

    def test_a_lowered_ratio_is_recorded_as_a_lowered_gate_whatever_the_env_default_is(self):
        # The comparison is against the shipped default (0.6), not against the env-tunable value in force.
        with mock.patch.object(vp, "MIN_REGISTRATION_RATIO", 0.2):
            details: dict = {}
            vp.check_registration_gates(30, 100, details, 24, 0.2)
        self.assertEqual((details["minRegistrationRatio"], details["gateLowered"]), (0.2, True))
        details = {}
        vp.check_registration_gates(30, 40, details, 24, vp.DEFAULT_MIN_REGISTRATION_RATIO)
        self.assertFalse(details["gateLowered"])
        details = {}
        vp.check_registration_gates(38, 40, details, 24, 0.9)  # a stricter gate is not a lowered one
        self.assertFalse(details["gateLowered"])
        self.assertEqual(vp.DEFAULT_MIN_REGISTRATION_RATIO, 0.6)

    def test_intake_knobs_are_bounded_so_zero_or_negative_values_fall_back_to_the_defaults(self):
        import json as _json
        import os
        import subprocess
        import sys

        knobs = {
            "KUBUS_PHOTO_MIN_COUNT": "0", "KUBUS_VIDEO_MIN_SECONDS": "-3", "KUBUS_VIDEO_MIN_MEDIAN_SHARPNESS": "0",
            "KUBUS_VIDEO_MAX_LONG_SIDE": "0", "KUBUS_PHOTO_MAX_LONG_SIDE": "-1", "KUBUS_VIDEO_MIN_TARGET_FRAMES": "0",
            "KUBUS_VIDEO_MAX_TARGET_FRAMES": "-4", "KUBUS_VIDEO_OVERSAMPLE": "0", "KUBUS_VIDEO_FRAMES_PER_SECOND": "0",
        }
        code = "import json, photo_pipeline as p, video_pipeline as v; print(json.dumps([p.MIN_PHOTOS, v.MIN_DURATION_SECONDS, v.MIN_MEDIAN_SHARPNESS, v.MAX_LONG_SIDE, p.PHOTO_MAX_LONG_SIDE, v.MIN_TARGET_FRAMES, v.MAX_TARGET_FRAMES, v.OVERSAMPLE_FACTOR, v.FRAMES_PER_SECOND_TARGET]))"
        here = os.path.dirname(os.path.abspath(__file__))
        done = subprocess.run([sys.executable, "-c", code], cwd=here, env={**os.environ, **knobs}, capture_output=True, text=True, check=True)
        self.assertEqual(_json.loads(done.stdout), [8, 3.0, 3.0, 1920, 2048, 48, 240, 2.5, 3.0])
        self.assertIn("is outside", done.stderr)
        lowered = subprocess.run([sys.executable, "-c", code], cwd=here, env={**os.environ, "KUBUS_PHOTO_MIN_COUNT": "5", "KUBUS_VIDEO_MIN_SECONDS": "1"}, capture_output=True, text=True, check=True)
        self.assertEqual(_json.loads(lowered.stdout)[:2], [5, 1.0])  # a valid lowered value still works

    def test_a_non_finite_or_out_of_range_gate_knob_never_disables_the_gate(self):
        for raw in ("nan", "inf", "-inf", "-0.1", "1.5", "abc"):
            with mock.patch.dict("os.environ", {"KUBUS_VIDEO_MIN_REGISTRATION_RATIO": raw}):
                self.assertEqual(vp._bounded_env("KUBUS_VIDEO_MIN_REGISTRATION_RATIO", 0.6, 0.0, 1.0), 0.6, raw)
        with mock.patch.dict("os.environ", {"KUBUS_VIDEO_MIN_REGISTRATION_RATIO": "0.3", "KUBUS_PHOTO_MIN_REGISTERED_VIEWS": "-5"}):
            self.assertEqual(vp._bounded_env("KUBUS_VIDEO_MIN_REGISTRATION_RATIO", 0.6, 0.0, 1.0), 0.3)  # a lowered, valid value still works
            self.assertEqual(vp._bounded_env("KUBUS_PHOTO_MIN_REGISTERED_VIEWS", 24, 3, 100_000), 24)
        with mock.patch.dict("os.environ", {"KUBUS_VIDEO_BLUR_RATIO": "nan"}):
            self.assertEqual(vp._float_env("KUBUS_VIDEO_BLUR_RATIO", 0.5), 0.5)
        # The check itself fails closed on a NaN or out-of-range ratio handed in directly.
        for bad in (float("nan"), float("inf"), -0.5, 1.5):
            details: dict = {}
            with self.assertRaises(vp.WorkerError) as refused:
                vp.check_registration_gates(30, 100, details, 24, bad)
            self.assertEqual(refused.exception.code, "sfm_failed")

    def test_the_floor_is_the_video_floor_unless_tuned(self):
        self.assertEqual(pp.PHOTO_MIN_REGISTERED_VIEWS, vp.MIN_VIEWS_FOR_RECONSTRUCTION)
        self.assertEqual(pp.PHOTO_MIN_REGISTRATION_RATIO, vp.MIN_REGISTRATION_RATIO)

    def test_the_best_of_several_models_is_chosen(self):
        capture = make_photo_capture(self.root, count=30)
        chosen = []

        def convert(model, dataset):
            chosen.append(model.name)
            return fake_convert(first_n(30))(model, dataset)

        pp.prepare_photo_dataset(FakeColmap(models=3), capture, self.root / "work", self.progress, convert=convert)
        self.assertEqual(chosen, ["0"])  # model 0 has all 30; 1 and 2 have 3 each

    def test_no_model_and_a_failing_stage_are_typed(self):
        capture = make_photo_capture(self.root, count=30)
        with self.assertRaises(vp.WorkerError) as none:
            self.run_photos(capture, FakeColmap(models=0))
        self.assertEqual(none.exception.code, "sfm_failed")
        self.assertEqual(none.exception.details["registeredViews"], 0)
        with self.assertRaises(vp.WorkerError) as stage:
            self.run_photos(capture, FakeColmap(fail_stage="exhaustive_matcher"))
        self.assertEqual(stage.exception.code, "sfm_failed")
        self.assertEqual(stage.exception.details["stage"], "matching")
        self.assertEqual(stage.exception.details["tail"], "CUDA error")

    def test_too_few_or_undecodable_photos_are_a_typed_error_before_colmap(self):
        few = make_photo_capture(self.root / "few", count=5)
        colmap = FakeColmap()
        with self.assertRaises(vp.WorkerError) as raised:
            pp.prepare_photo_dataset(colmap, few, self.root / "w1", self.progress)
        self.assertEqual(raised.exception.code, "photos_unreadable")
        self.assertEqual(raised.exception.details["submittedPhotos"], 5)
        self.assertEqual(colmap.calls, [])
        broken = make_photo_capture(self.root / "broken", count=0)
        for index in range(12):
            (broken / "photos" / f"{index}.jpg").write_bytes(b"\xff\xd8\xff garbage")
        with self.assertRaises(vp.WorkerError) as undecodable:
            pp.prepare_photo_dataset(colmap, broken, self.root / "w2", self.progress)
        self.assertEqual(undecodable.exception.code, "photos_unreadable")
        self.assertEqual(undecodable.exception.details["usablePhotos"], 0)
        self.assertEqual(colmap.calls, [])

    def test_masking_covers_photos_and_video_frames_and_counts_each_image(self):
        from test_face_mask import FakeMasker

        capture = make_photo_capture(self.root, count=20)
        (capture / "video").mkdir()
        (capture / "video" / "source.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
        colmap = FakeColmap()
        video = FakeTools(probe=probe_json(duration=10.0), frames=[(1000 + i, 0) for i in range(120)])

        def runner(command, timeout):
            return video(command, timeout) if command[0] in ("ffprobe", "ffmpeg") else colmap(command, timeout)

        result = pp.prepare_photo_dataset(
            runner, capture, self.root / "work", self.progress, include_video=True, convert=fake_convert(first_n(10_000)),
            mask_photos=True, mask_video=True, masker=FakeMasker([(30, 30, 80, 90)]),
        )
        self.assertIn("masking_faces", [stage for stage, _ in self.stages])
        self.assertEqual(result["masking"]["photos"], [1] * 20)
        self.assertEqual(result["masking"]["video"], [1] * result["frames"]["selected"])
        # Where each masked image is under the job's directory (for the operator's look), and where a frame is in the footage.
        work = self.root / "work"
        files = result["masking"]["photosFiles"] + result["masking"]["videoFiles"]
        self.assertEqual(result["masking"]["photosFiles"][:2], ["dataset/images/photo_00000.jpg", "dataset/images/photo_00001.jpg"])
        self.assertEqual(len(result["masking"]["videoFiles"]), result["frames"]["selected"])
        self.assertTrue(all((work / name).is_file() for name in files))
        self.assertEqual(len(result["masking"]["videoSeconds"]), result["frames"]["selected"])
        self.assertEqual(result["masking"]["videoSeconds"], sorted(result["masking"]["videoSeconds"]))

    def test_photos_only_masking_leaves_video_frames_alone(self):
        from test_face_mask import FakeMasker

        capture = make_photo_capture(self.root, count=30)
        result = pp.prepare_photo_dataset(
            FakeColmap(), capture, self.root / "work", self.progress, convert=fake_convert(first_n(10_000)),
            mask_photos=True, masker=FakeMasker([(30, 30, 80, 90)]),
        )
        self.assertEqual(result["masking"]["photos"], [1] * 30)
        self.assertIsNone(result["masking"]["video"])
        self.assertIsNone(result["masking"]["videoFiles"])
        self.assertEqual(len(result["masking"]["photosFiles"]), 30)
        unmasked = pp.prepare_photo_dataset(FakeColmap(), capture, self.root / "work2", self.progress, convert=fake_convert(first_n(10_000)))
        self.assertIsNone(unmasked["masking"]["photos"])
        self.assertIsNone(unmasked["masking"]["photosFiles"])

    def test_a_missing_detector_fails_the_job_before_any_image_is_written(self):
        capture = make_photo_capture(self.root, count=12)
        from face_mask import FaceMaskingError

        with unittest.mock.patch.object(pp, "FaceMasker", side_effect=FaceMaskingError("weights missing")):
            with self.assertRaises(FaceMaskingError):
                pp.prepare_photo_dataset(FakeColmap(), capture, self.root / "work", self.progress, mask_photos=True)
        self.assertFalse((self.root / "work" / "dataset" / "images").exists() and any((self.root / "work" / "dataset" / "images").iterdir()))

    def test_a_mixed_capture_solves_photos_and_video_frames_together_with_one_camera_for_the_video(self):
        capture = make_photo_capture(self.root, count=20)
        (capture / "video").mkdir()
        (capture / "video" / "source.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
        colmap = FakeColmap()
        video = FakeTools(probe=probe_json(duration=10.0), frames=[(1000 + i, 0) for i in range(120)])

        def runner(command, timeout):
            return video(command, timeout) if command[0] in ("ffprobe", "ffmpeg") else colmap(command, timeout)

        result = self.run_photos(capture, colmap, include_video=True, tools=runner)
        self.assertEqual([stage for stage, _ in self.stages], ["preparing_photos", "extracting_frames", "solving_poses"])
        self.assertEqual(result["photos"]["usable"], 20)
        self.assertEqual(result["frames"]["selected"], vp.plan_frames(10.0)[0])
        self.assertEqual(result["sfm"]["registeredPhotos"], 20)
        self.assertEqual(result["sfm"]["registeredVideoFrames"], result["frames"]["selected"])
        extracts = [call for call in colmap.calls if call[1] == "feature_extractor"]
        self.assertEqual([call[call.index("--ImageReader.single_camera") + 1] for call in extracts], ["0", "1"])
        listings = [pathlib.Path(call[call.index("--image_list_path") + 1]).read_text().split() for call in extracts]
        self.assertTrue(all(name.startswith("photo_") for name in listings[0]))
        self.assertTrue(all(name.startswith("video_") for name in listings[1]))
        self.assertEqual(len(listings[0]) + len(listings[1]), result["sfm"]["submittedViews"])


if __name__ == "__main__":
    unittest.main()
