"""Photo-set intake tests. COLMAP, ffmpeg and ffprobe are fakes; Pillow, OpenCV and NumPy are real."""
import json
import pathlib
import struct
import tempfile
import unittest

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
