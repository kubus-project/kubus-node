"""Source-set (photos plus several clips) preparation tests. COLMAP, ffmpeg and ffprobe are fakes."""
import json
import pathlib
import tempfile
import unittest

import source_set as ss
import video_pipeline as vp
from test_face_mask import FakeMasker
from test_photo_pipeline import FakeColmap, fake_convert, first_n, write_jpeg
from test_video_pipeline import FakeTools, probe_json

CLIP = b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64


class SourceSetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = pathlib.Path(self.temp.name)
        self.stages = []
        self.progress = lambda stage, detail: self.stages.append((stage, detail))

    def capture(self, photos=10, clips=2, broken_photo=False):
        capture = self.root / "capture"
        (capture / "photos").mkdir(parents=True)
        for index in range(photos):
            write_jpeg(capture / "photos" / f"{index + 1:05d}.jpg", seed=index)
        if broken_photo:
            (capture / "photos" / "99999.jpg").write_bytes(b"\xff\xd8\xff\xe0not an image")
        if clips:
            (capture / "videos").mkdir()
            for index in range(clips):
                (capture / "videos" / f"clip_{index:02d}.mp4").write_bytes(CLIP)
        return capture

    def runner(self, colmap, tools_by_clip):
        def run(command, timeout):
            if command[0] in ("ffprobe", "ffmpeg"):
                source = next(part for part in command if part.endswith(".mp4"))
                return tools_by_clip[pathlib.Path(source).name](command, timeout)
            return colmap(command, timeout)
        return run

    def good_clip(self, seed):
        return FakeTools(probe=probe_json(duration=10.0), frames=[(seed + i, 0) for i in range(120)])

    def test_photos_and_two_clips_become_one_masked_dataset_with_global_frame_names(self):
        capture = self.capture()
        runner = self.runner(FakeColmap(), {"clip_00.mp4": self.good_clip(1000), "clip_01.mp4": self.good_clip(5000)})
        result = ss.prepare_source_set(runner, capture, self.root / "work", self.progress,
                                       masker=FakeMasker([(30, 30, 80, 90)]), convert=fake_convert(first_n(10_000)))
        names = sorted(path.name for path in (result["dataset"] / "images").glob("*.jpg"))
        photos = [name for name in names if name.startswith("photo_")]
        frames = [name for name in names if name.startswith("video_")]
        self.assertEqual(len(photos), 10)
        self.assertEqual(frames[0], "video_00000.jpg")
        # Frames of both clips are numbered on, never colliding.
        clip_inputs = [item for item in result["inputs"] if item["kind"] == "clip"]
        self.assertEqual(sum(item["submittedViews"] for item in clip_inputs), len(frames))
        self.assertTrue(all(item["usable"] for item in result["inputs"]))
        self.assertEqual([item["input"] for item in clip_inputs], ["videos/clip_00.mp4", "videos/clip_01.mp4"])
        self.assertEqual(result["masking"]["photos"], [1] * 10)
        self.assertEqual(len(result["masking"]["video"]), len(frames))
        self.assertIn("masking_faces", [stage for stage, _ in self.stages])
        # No unmasked raw extraction is left beside the dataset.
        self.assertFalse(any((self.root / "work").glob("raw_frames*")))
        self.assertFalse(any((self.root / "work").glob("clip_*")))

    def test_an_unreadable_clip_is_reported_while_the_rest_of_the_set_goes_on(self):
        capture = self.capture(photos=12, clips=2)
        broken = FakeTools(probe=probe_json(duration=10.0), probe_returncode=1)
        runner = self.runner(FakeColmap(), {"clip_00.mp4": broken, "clip_01.mp4": self.good_clip(2000)})
        result = ss.prepare_source_set(runner, capture, self.root / "work", self.progress,
                                       masker=FakeMasker([]), convert=fake_convert(first_n(10_000)))
        first = next(item for item in result["inputs"] if item["input"] == "videos/clip_00.mp4")
        self.assertEqual(first, {"input": "videos/clip_00.mp4", "kind": "clip", "submittedViews": 0,
                                 "usableViews": 0, "usable": False, "reason": "video_unreadable"})

    def test_views_colmap_does_not_register_are_counted_per_input(self):
        capture = self.capture(photos=30, clips=0, broken_photo=True)
        # Register only the first 26 photos (above the 24-view gate).
        result = ss.prepare_source_set(FakeColmap(registered=26), capture, self.root / "work", self.progress,
                                       masker=FakeMasker([]), convert=fake_convert(first_n(26)))
        usable = [item for item in result["inputs"] if item["usable"]]
        self.assertEqual(len(usable), 26)
        reasons = {item["reason"] for item in result["inputs"] if not item["usable"]}
        self.assertEqual(reasons, {"not_registered", "unreadable"})

    def test_a_failed_pose_solve_carries_the_per_input_feedback(self):
        capture = self.capture(photos=10, clips=0)
        with self.assertRaises(vp.WorkerError) as raised:
            ss.prepare_source_set(FakeColmap(registered=3), capture, self.root / "work", self.progress,
                                  masker=FakeMasker([]), convert=fake_convert(first_n(3)))
        self.assertEqual(raised.exception.code, "sfm_failed")
        inputs = raised.exception.details["inputs"]
        self.assertEqual(len(inputs), 10)
        self.assertTrue(all(item["submittedViews"] == 1 for item in inputs))

    def test_an_empty_set_is_refused(self):
        capture = self.root / "capture"
        capture.mkdir()
        with self.assertRaises(vp.WorkerError) as raised:
            ss.prepare_source_set(FakeColmap(), capture, self.root / "work", self.progress, masker=FakeMasker([]))
        self.assertEqual(raised.exception.code, "no_usable_inputs")

    def test_the_prepared_record_round_trips_and_rejects_other_schemas(self):
        dataset = self.root / "dataset"
        dataset.mkdir()
        ss.write_prepared_record(dataset, {"workerVersion": "x", "sfm": {"registeredViews": 30}})
        self.assertEqual(ss.read_prepared_record(dataset)["sfm"], {"registeredViews": 30})
        (dataset / "prepared.json").write_text(json.dumps({"schema": "other"}))
        with self.assertRaises(vp.WorkerError):
            ss.read_prepared_record(dataset)


if __name__ == "__main__":
    unittest.main()
