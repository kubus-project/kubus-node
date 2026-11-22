"""Tests for face masking. A fake detector stands in for YuNet wherever the test is about what is done with
a detection; the pinned weights are checked for real, and the real detector is run once on an empty image."""
import hashlib
import json
import pathlib
import shutil
import tempfile
import unittest
from unittest import mock

import numpy as np
from PIL import Image

import face_mask as fm
import photo_pipeline as pp


class FakeMasker(fm.FaceMasker):
    """Reports the boxes it was given instead of running the network."""

    def __init__(self, boxes=None):  # no weights check: the detector is the fake
        self.boxes = boxes or []
        self.version = {"opencv": "x", **fm.DETECTOR_INFO, "weightsSha256": "a" * 64, "scoreThreshold": 0.4}

    def detect_detailed(self, rgb):
        # (x0, y0, x1, y1) or (x0, y0, x1, y1, strong)
        return [(tuple(box[:4]), bool(box[4]) if len(box) > 4 else False) for box in self.boxes]


def noisy(width=400, height=300, seed=1):
    return np.random.default_rng(seed).integers(0, 256, (height, width, 3), dtype=np.uint8)


class WeightsAreChecked(unittest.TestCase):
    def test_the_shipped_weights_match_the_pinned_checksum(self):
        self.assertEqual(fm.verify_weights(), fm.MODEL_SHA256)
        self.assertEqual(hashlib.sha256(fm.model_path().read_bytes()).hexdigest(), fm.MODEL_SHA256)

    def test_altered_weights_are_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            altered = pathlib.Path(temp)
            data = bytearray(fm.model_path().read_bytes())
            data[100] ^= 0xFF
            (altered / fm.MODEL_FILE).write_bytes(bytes(data))
            with mock.patch.object(fm, "MODEL_DIRECTORY", altered):
                with self.assertRaises(fm.FaceMaskingError):
                    fm.FaceMasker()

    def test_missing_weights_are_refused(self):
        with tempfile.TemporaryDirectory() as temp:
            with mock.patch.object(fm, "MODEL_DIRECTORY", pathlib.Path(temp)):
                with self.assertRaises(fm.FaceMaskingError):
                    fm.FaceMasker()

    def test_the_real_detector_loads_and_finds_nothing_in_noise(self):
        masker = fm.FaceMasker()
        self.assertEqual(masker.detect(noisy(640, 480)), [])
        self.assertEqual(masker.version["weightsSha256"], fm.MODEL_SHA256)
        self.assertEqual(masker.version["licence"], "MIT")


class Geometry(unittest.TestCase):
    def row(self, rotate=0.0, mirror=False):
        # right eye, left eye, nose, right and left mouth corner of an upright 100 px face at the origin
        points = np.array([[30, 40], [70, 40], [50, 58], [34, 78], [66, 78]], dtype=float)
        if mirror:
            points[:, 0] = 100 - points[:, 0]
        centre = np.array([50.0, 50.0])
        angle = np.radians(rotate)
        matrix = np.array([[np.cos(angle), -np.sin(angle)], [np.sin(angle), np.cos(angle)]])
        points = (points - centre) @ matrix.T + centre
        return [0, 0, 100, 100, *points.reshape(-1), 0.5]

    def test_a_face_layout_is_plausible_at_any_rotation(self):
        for angle in (0, 25, 90, 180, 270):
            self.assertTrue(fm.plausible_layout(self.row(angle)), angle)

    def test_a_mirrored_or_scattered_layout_is_not(self):
        self.assertFalse(fm.plausible_layout(self.row(mirror=True)))
        scattered = [0, 0, 100, 100, 10, 90, 20, 10, 80, 20, 90, 90, 15, 50, 0.5]
        self.assertFalse(fm.plausible_layout(scattered))

    def test_boxes_of_the_same_face_merge_but_neighbours_and_nested_boxes_do_not_grow(self):
        same = [(10, 10, 60, 60, 0.9), (12, 11, 62, 61, 0.8)]
        self.assertEqual(len(fm.merge_boxes(same)), 1)
        apart = [(10, 10, 60, 60, 0.9), (100, 10, 150, 60, 0.8)]
        self.assertEqual(len(fm.merge_boxes(apart)), 2)
        chain = [(0, 0, 50, 50, 0.9), (30, 0, 80, 50, 0.8), (60, 0, 110, 50, 0.7)]  # a chain must not become one huge box
        for box in fm.merge_boxes(chain):
            self.assertLessEqual(box[2] - box[0], 50)

    def test_grown_box_covers_forehead_ears_and_chin_and_stays_inside_the_image(self):
        x0, y0, x1, y1 = fm.grow_box((100, 100, 140, 150), 300, 300)
        self.assertLess(x0, 100 - 0.4 * 40 + 1)
        self.assertLess(y0, 100 - 0.6 * 50 + 1)
        self.assertGreater(y1, 150 + 0.3 * 50 - 1)
        self.assertEqual(fm.grow_box((0, 0, 20, 20), 25, 25)[:2], (0, 0))
        self.assertLessEqual(fm.grow_box((10, 10, 24, 24), 25, 25)[2], 25)


class Masking(unittest.TestCase):
    def test_a_detected_face_becomes_one_flat_colour_and_the_rest_is_untouched(self):
        image = noisy()
        masker = FakeMasker([(150, 100, 210, 170)])
        masked, count = masker.mask_array(image)
        self.assertEqual(count, 1)
        x0, y0, x1, y1 = fm.grow_box((150, 100, 210, 170), 400, 300)
        patch = masked[y0:y1, x0:x1].reshape(-1, 3)
        self.assertEqual(len(np.unique(patch, axis=0)), 1)  # nothing of the face survives: one value
        outside = np.ones(image.shape[:2], dtype=bool)
        outside[y0:y1, x0:x1] = False
        self.assertTrue(np.array_equal(masked[outside], image[outside]))
        self.assertFalse(np.array_equal(image[y0:y1, x0:x1], masked[y0:y1, x0:x1]))  # the input array itself is not modified

    def test_no_face_no_change(self):
        image = noisy()
        masked, count = FakeMasker([]).mask_array(image)
        self.assertEqual(count, 0)
        self.assertTrue(np.array_equal(masked, image))

    def test_manual_add_masks_a_missed_face_and_exclude_keeps_a_painted_one(self):
        image = noisy()
        masker = FakeMasker([(150, 100, 210, 170), (20, 20, 60, 70)])
        masked, count = masker.mask_array(image, {"exclude": [[0.0, 0.0, 0.25, 0.35]], "add": [[0.7, 0.6, 0.9, 0.9]]})
        self.assertEqual(count, 2)  # the detection inside the exclude box is dropped, the added box is masked
        self.assertTrue(np.array_equal(masked[20:70, 20:60], image[20:70, 20:60]))
        self.assertEqual(len(np.unique(masked[int(0.6 * 300):int(0.9 * 300), int(0.7 * 400):int(0.9 * 400)].reshape(-1, 3), axis=0)), 1)

    def test_an_exclude_box_must_have_swallowed_exactly_the_near_certain_faces_the_reviewer_expects(self):
        image = noisy()
        masker = FakeMasker([(20, 20, 60, 70, True)])  # a near-certain face inside the box
        with self.assertRaises(fm.FaceMaskingError):  # a bare box expects none: a real person could hide here
            masker.mask_array(image, {"exclude": [[0.0, 0.0, 0.25, 0.35]]})
        masked, count = masker.mask_array(image, {"exclude": [{"box": [0.0, 0.0, 0.25, 0.35], "expectStrong": 1, "note": "painted head"}]})
        self.assertEqual(count, 0)
        self.assertTrue(np.array_equal(masked, image))
        with self.assertRaises(fm.FaceMaskingError):  # the reviewer expected one and none turned up
            FakeMasker([]).mask_array(image, {"exclude": [{"box": [0.0, 0.0, 0.25, 0.35], "expectStrong": 1}]})
        audit = []
        masker.mask_array(image, {"exclude": [[0.0, 0.0, 0.25, 0.35]]}, audit=audit)
        self.assertEqual(audit, [{"box": 0, "strongExcluded": 1, "expectStrong": 0, "weakExcluded": 0, "expectWeak": None, "ok": False}])

    def test_a_weak_detection_inside_an_exclude_box_needs_no_expectation_but_is_reported_for_a_human_to_look_at(self):
        review = {}
        masked, count = FakeMasker([(20, 20, 60, 70, False)]).mask_array(noisy(), {"exclude": [[0.0, 0.0, 0.25, 0.35]]}, review=review)
        self.assertEqual(count, 0)
        self.assertEqual(review["weakExcluded"], 1)

    def test_a_reviewer_who_looked_can_pin_the_weak_count_and_a_different_count_stops_the_run(self):
        image = noisy()
        looked = {"box": [0.0, 0.0, 0.25, 0.35], "expectWeak": 1}
        review = {}
        FakeMasker([(20, 20, 60, 70, False)]).mask_array(image, {"exclude": [looked]}, review=review)
        self.assertEqual(review["weakExcluded"], 0)  # acknowledged: not listed again
        with self.assertRaises(fm.FaceMaskingError):  # a second, weak face turned up in the same box
            FakeMasker([(20, 20, 60, 70, False), (60, 30, 90, 70, False)]).mask_array(image, {"exclude": [looked]})

    def test_a_large_detection_that_was_not_near_certain_is_reported(self):
        class Looks(FakeMasker):
            def detect_detailed(self, rgb):
                self.last_review = {"largeBelowCertain": 2}
                return super().detect_detailed(rgb)

        review = {}
        Looks([]).mask_array(noisy(), review=review)
        self.assertEqual(review, {"weakExcluded": 0, "largeBelowCertain": 2})

    def test_a_face_that_only_overlaps_an_exclude_box_is_still_masked(self):
        # Centre outside, or less than half of the face inside, so a person beside a painted head is not swallowed.
        image = noisy()
        beside = FakeMasker([(90, 20, 130, 70, True)])  # centre x 110 is right of the box edge (100)
        _, count = beside.mask_array(image, {"exclude": [{"box": [0.0, 0.0, 0.25, 0.35], "expectStrong": 0}]})
        self.assertEqual(count, 1)
        edge = FakeMasker([(60, 20, 110, 70, True)])  # centre x 85 inside, but only 40 of 50 px inside: contained 0.8
        _, inside = edge.mask_array(image, {"exclude": [{"box": [0.0, 0.0, 0.25, 0.35], "expectStrong": 1}]})
        self.assertEqual(inside, 0)
        mostly_out = FakeMasker([(90, 20, 190, 70, True)])  # centre x 140 outside the box
        self.assertEqual(mostly_out.mask_array(image, {"exclude": [[0.0, 0.0, 0.25, 0.35]]})[1], 1)
        lopsided = fm.excludes_detection((0, 0, 100, 100), (60, 0, 140, 50))  # centre x 100 is on the edge, half inside
        self.assertTrue(lopsided)
        self.assertFalse(fm.excludes_detection((0, 0, 100, 100), (70, 0, 190, 50)))  # centre outside

    def test_a_box_over_a_third_of_the_image_needs_allow_large(self):
        image = noisy()
        with self.assertRaises(fm.FaceMaskingError):
            FakeMasker([]).mask_array(image, {"exclude": [[0.0, 0.0, 1.0, 1.0]]})
        masked, count = FakeMasker([]).mask_array(image, {"exclude": [{"box": [0.0, 0.0, 1.0, 1.0], "allowLarge": True}]})
        self.assertEqual(count, 0)

    def test_the_merge_keeps_a_face_strong_when_any_pass_found_it_near_certainly(self):
        merged = fm.merge_detections([(10, 10, 60, 60, 0.95, False), (12, 11, 62, 61, 0.5, True), (200, 10, 250, 60, 0.9, False)])
        self.assertEqual([strong for _, strong in merged], [True, False])

    def test_a_non_srgb_profile_is_converted_and_an_srgb_or_missing_one_is_left_alone(self):
        from PIL import ImageCms

        image = Image.fromarray(noisy(32, 32))
        profile = ImageCms.ImageCmsProfile(ImageCms.createProfile("sRGB")).tobytes()
        same, kept = fm.to_srgb(image, profile)
        self.assertIs(same, image)
        self.assertEqual(kept, profile)
        self.assertEqual(fm.to_srgb(image, None), (image, None))
        with mock.patch.object(ImageCms, "getProfileDescription", return_value="Display P3"):
            converted, embedded = fm.to_srgb(image, profile)
        self.assertIsNot(converted, image)
        self.assertEqual(converted.size, image.size)
        self.assertTrue(embedded)
        garbage, dropped = fm.to_srgb(image, b"not an icc profile")
        self.assertIs(garbage, image)
        self.assertIsNone(dropped)

    def test_summary_counts_regions_without_coordinates(self):
        summary = fm.summarise([0, 2, 1, 0], photo_images=4, version={"name": "YuNet", "model": "m", "weightsSha256": "b" * 64, "scoreThreshold": 0.4, "licence": "MIT"})
        self.assertEqual((summary["ran"], summary["images"], summary["regions"], summary["imagesWithRegions"]), (True, 4, 3, 2))
        self.assertEqual(summary["regionsPerImage"], [0, 2, 1, 0])
        self.assertEqual(summary["histogram"], {"0": 2, "2": 1, "1": 1})
        self.assertNotIn("boxes", json.dumps(summary))


class Directory(unittest.TestCase):
    def test_masked_copies_are_written_with_a_report_bound_by_checksum_and_the_input_is_untouched(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            source, target = root / "in", root / "out"
            source.mkdir()
            for index in range(3):
                Image.fromarray(noisy(seed=index)).save(source / f"IMG_{index}.jpg", "JPEG", quality=92)
            before = {path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in source.iterdir()}
            report = fm.mask_directory(source, target, {"IMG_1.jpg": {"add": [[0.1, 0.1, 0.4, 0.4]]}}, masker=FakeMasker([(150, 100, 210, 170)]))
            self.assertEqual({path.name: hashlib.sha256(path.read_bytes()).hexdigest() for path in source.iterdir()}, before)
            self.assertEqual(report["totals"], {"images": 3, "regions": 4, "imagesWithRegions": 3, "manualAdded": 1, "manualExcluded": 0})
            written = json.loads((target / fm.REPORT_NAME).read_text(encoding="utf-8"))
            self.assertEqual(written["schema"], fm.REPORT_SCHEMA)
            for entry, name in zip(written["images"], ["IMG_0.jpg", "IMG_1.jpg", "IMG_2.jpg"]):
                self.assertEqual(entry["sha256"], hashlib.sha256((target / name).read_bytes()).hexdigest())
            self.assertEqual([entry["regions"] for entry in written["images"]], [1, 2, 1])
            sheets = fm.contact_sheets(target, root / "sheets")
            self.assertEqual(len(sheets), 1)

    def test_what_a_human_has_to_look_at_is_in_the_report_but_not_a_failure(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            source, target = root / "in", root / "out"
            source.mkdir()
            Image.fromarray(noisy()).save(source / "a.jpg", "JPEG", quality=92)
            Image.fromarray(noisy(seed=2)).save(source / "b.jpg", "JPEG", quality=92)
            manual = {"a.jpg": {"exclude": [[0.0, 0.0, 0.25, 0.35]]}}
            report = fm.mask_directory(source, target, manual, masker=FakeMasker([(20, 20, 60, 70, False)]))
            self.assertEqual(report["review"], {"needsLook": [{"image": "a.jpg", "weakExcluded": 1}]})
            self.assertEqual(report["images"][0]["needsLook"], {"weakExcluded": 1})
            self.assertNotIn("needsLook", report["images"][1])
            self.assertTrue(len(report["images"]) == 2 and (target / fm.REPORT_NAME).exists())

    def test_a_multi_picture_jpeg_stays_a_jpeg_with_its_exif(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            source, target = root / "in", root / "out"
            source.mkdir()
            exif = Image.Exif()
            exif[0x0110] = "Model"
            first = Image.fromarray(noisy(200, 100))
            first.save(source / "p.jpg", format="MPO", exif=exif.tobytes(), save_all=True, append_images=[Image.fromarray(noisy(100, 50, seed=3))])
            with Image.open(source / "p.jpg") as probe:
                self.assertEqual(probe.format, "MPO")
            fm.mask_directory(source, target, masker=FakeMasker([]))
            self.assertEqual(sorted(path.name for path in target.iterdir()), [fm.REPORT_NAME, "p.jpg"])
            with Image.open(target / "p.jpg") as copy:
                self.assertEqual(copy.format, "JPEG")
                self.assertEqual(copy.getexif().get(0x0110), "Model")

    def test_two_inputs_with_the_same_stem_are_refused_instead_of_overwriting_each_other(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            source, target = root / "in", root / "out"
            source.mkdir()
            Image.fromarray(noisy()).save(source / "a.jpg", "JPEG")
            Image.fromarray(noisy()).save(source / "a.png", "PNG")
            with self.assertRaises(fm.FaceMaskingError):
                fm.mask_directory(source, target, masker=FakeMasker([]))
            self.assertFalse((target / fm.REPORT_NAME).exists())

    def test_a_mismatched_exclude_box_stops_a_directory_run_before_any_report_exists(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            source, target = root / "in", root / "out"
            source.mkdir()
            Image.fromarray(noisy()).save(source / "a.jpg", "JPEG", quality=92)
            manual = {"a.jpg": {"exclude": [[0.0, 0.0, 0.25, 0.35]]}}
            masker = FakeMasker([(20, 20, 60, 70, True)])
            with self.assertRaises(fm.FaceMaskingError):
                fm.mask_directory(source, target, manual, masker=masker)
            self.assertFalse((target / fm.REPORT_NAME).exists())
            discovered = fm.mask_directory(source, target, manual, masker=masker, discover=True)
            self.assertEqual(discovered["excludeAudit"][0]["strongExcluded"], 1)

    def test_orientation_is_baked_and_gps_is_dropped_from_the_copy(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            source, target = root / "in", root / "out"
            source.mkdir()
            exif = Image.Exif()
            exif[0x0112] = 6  # rotated a quarter turn
            exif[0x010F] = "Maker"
            exif[0x0110] = "Model"
            exif[0x8825] = {1: "N"}  # GPS
            Image.fromarray(noisy(200, 100)).save(source / "a.jpg", "JPEG", exif=exif.tobytes())
            fm.mask_directory(source, target, masker=FakeMasker([]))
            with Image.open(target / "a.jpg") as copy:
                self.assertEqual(copy.size, (100, 200))  # upright now
                tags = copy.getexif()
                self.assertEqual(tags.get(0x0110), "Model")
                self.assertIsNone(tags.get(0x0112))
                self.assertNotIn(0x8825, tags)


class JobPath(unittest.TestCase):
    def test_prepare_photo_masks_before_the_downscale_and_reports_the_count(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            Image.fromarray(noisy(1200, 900)).save(root / "a.jpg", "JPEG", quality=95)
            seen = {}

            class Spy(FakeMasker):
                def mask_array(self, rgb, manual=None):
                    seen["shape"] = rgb.shape
                    return super().mask_array(rgb, manual)

            facts = pp.prepare_photo(root / "a.jpg", root / "out.jpg", max_long_side=600, masker=Spy([(500, 300, 600, 420)]))
            self.assertEqual(seen["shape"], (900, 1200, 3))  # full resolution
            self.assertEqual(facts["maskedRegions"], 1)
            self.assertEqual(facts["width"], 600)

    def test_a_masking_failure_stops_the_set_and_leaves_no_unmasked_file(self):
        class Broken(FakeMasker):
            def mask_array(self, rgb, manual=None):
                raise RuntimeError("boom")

        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            for index in range(2):
                Image.fromarray(noisy(seed=index)).save(root / f"{index}.jpg", "JPEG")
            out = root / "images"
            with self.assertRaises(fm.FaceMaskingError):
                pp.prepare_photos([root / "0.jpg", root / "1.jpg"], out, "photo", masker=Broken())
            self.assertEqual(list(out.glob("*.jpg")), [])

    def test_prepare_photos_without_a_masker_is_unchanged(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            Image.fromarray(noisy()).save(root / "0.jpg", "JPEG")
            names, stats = pp.prepare_photos([root / "0.jpg"], root / "images", "photo")
            self.assertEqual(names, ["photo_00000.jpg"])
            self.assertNotIn("maskedRegions", stats)

    def test_masking_provenance_per_part(self):
        version = FakeMasker().version
        provenance = fm.masking_provenance({"photos": [0, 3], "video": None, "version": version})
        self.assertEqual(provenance["photos"]["regions"], 3)
        self.assertNotIn("video", provenance)
        self.assertIsNone(fm.masking_provenance({"photos": None, "video": None, "version": None}))

    def test_mask_files_masks_in_place_and_keeps_the_dataset_dimensions(self):
        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            Image.fromarray(noisy(320, 240)).save(root / "video_00000.jpg", "JPEG")
            counts = fm.mask_files(FakeMasker([(100, 60, 160, 130)]), root, ["video_00000.jpg"])
            self.assertEqual(counts, [1])
            with Image.open(root / "video_00000.jpg") as image:
                self.assertEqual(image.size, (320, 240))

    def test_a_face_missed_in_the_middle_of_three_frames_is_masked_there_too(self):
        class Scripted(FakeMasker):
            def __init__(self, per_frame):
                super().__init__()
                self.per_frame = list(per_frame)
                self.calls = 0

            def find_regions(self, rgb, manual=None, audit=None, review=None):
                regions = self.per_frame[self.calls]
                self.calls += 1
                return list(regions)

        with tempfile.TemporaryDirectory() as temp:
            root = pathlib.Path(temp)
            names = [f"video_{index:05d}.jpg" for index in range(4)]
            for index, name in enumerate(names):
                Image.fromarray(noisy(320, 240, seed=index)).save(root / name, "JPEG", quality=95)
            face = (100, 60, 160, 130)
            moved = (110, 62, 170, 132)
            counts = fm.mask_frame_sequence(Scripted([[face], [], [moved], []]), root, names)
            self.assertEqual(counts, [1, 2, 1, 0])  # frame 1 got both neighbours' regions, the edge frame 3 is not filled
            with Image.open(root / names[1]) as image:
                patch = np.asarray(image)[60:130, 100:160].reshape(-1, 3)
                self.assertLess(len(np.unique(patch, axis=0)), 60 * 70 // 4)  # flat colour (JPEG noise aside), not the noise

    def test_carry_over_needs_both_neighbours_and_an_empty_middle(self):
        a, b = (10, 10, 60, 60), (200, 10, 250, 60)
        self.assertEqual(fm.carry_over([[a], [], [a]]), [[], [a, a], []])
        self.assertEqual(fm.carry_over([[a], [], []]), [[], [], []])  # only one neighbour has it
        self.assertEqual(fm.carry_over([[a], [a], [a]]), [[], [], []])  # the middle frame found it itself
        self.assertEqual(fm.carry_over([[a], [b], [a]]), [[], [a, a], []])  # a different face in the middle does not cover a
        self.assertEqual(fm.carry_over([[a], []]), [[], []])


if __name__ == "__main__":
    unittest.main()
