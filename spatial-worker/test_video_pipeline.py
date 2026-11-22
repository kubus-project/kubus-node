"""Video intake tests. Every external tool is a fake; no GPU, ffmpeg or COLMAP is needed."""
import json
import pathlib
import subprocess
import tempfile
import unittest

import cv2
import numpy as np

import video_pipeline as vp


def completed(command, returncode=0, stdout="", stderr=""):
    return subprocess.CompletedProcess(command, returncode, stdout, stderr)


def probe_json(duration=20.0, width=1920, height=1080, codec="h264", streams=None):
    return json.dumps({
        "streams": streams if streams is not None else [{
            "codec_type": "video", "codec_name": codec, "width": width, "height": height,
            "avg_frame_rate": "30/1", "duration": str(duration),
        }],
        "format": {"duration": str(duration)},
    })


def write_frame(path, seed, blur=0):
    image = np.random.default_rng(seed).integers(0, 255, size=(120, 160, 3), dtype=np.uint8)
    if blur:
        image = cv2.GaussianBlur(image, (0, 0), blur)
    cv2.imwrite(str(path), image)


class FakeTools:
    """Dispatches on the executable name, recording every call."""

    def __init__(self, probe=None, frames=None, sfm_registered=None, sfm_returncode=0, ffmpeg_returncode=0, probe_returncode=0):
        self.calls = []
        self.probe = probe if probe is not None else probe_json()
        # frames: list of (seed, blur) per extracted frame, in time order
        self.frames = frames if frames is not None else [(index, 0) for index in range(120)]
        self.sfm_registered = sfm_registered
        self.sfm_returncode = sfm_returncode
        self.ffmpeg_returncode = ffmpeg_returncode
        self.probe_returncode = probe_returncode

    def __call__(self, command, timeout):
        self.calls.append(list(command))
        tool = command[0]
        if tool == "ffprobe":
            return completed(command, self.probe_returncode, self.probe, "" if self.probe_returncode == 0 else "moov atom not found")
        if tool == "ffmpeg":
            if self.ffmpeg_returncode == 0:
                destination = pathlib.Path(command[-1]).parent
                for index, (seed, blur) in enumerate(self.frames):
                    write_frame(destination / f"{index:05d}.jpg", seed, blur)
            return completed(command, self.ffmpeg_returncode, "", "decode error" if self.ffmpeg_returncode else "")
        if tool == "ns-process-data":
            frames_dir = pathlib.Path(command[command.index("--data") + 1])
            dataset = pathlib.Path(command[command.index("--output-dir") + 1])
            submitted = len(list(frames_dir.glob("*.jpg")))
            if self.sfm_returncode != 0:
                return completed(command, self.sfm_returncode, "", "COLMAP failed to reconstruct")
            registered = submitted if self.sfm_registered is None else self.sfm_registered
            (dataset / "images").mkdir(parents=True, exist_ok=True)
            (dataset / "sparse_pc.ply").write_text("ply\nformat ascii 1.0\nelement vertex 3\nend_header\n0 0 0\n1 1 1\n2 2 2\n")
            (dataset / "transforms.json").write_text(json.dumps({
                "ply_file_path": "sparse_pc.ply",
                "frames": [{"file_path": f"images/frame_{i:05d}.jpg"} for i in range(registered)],
            }))
            return completed(command, 0, "ok")
        if tool == "colmap":
            return completed(command, 0, "COLMAP 3.9.1 -- Structure-from-Motion and Multi-View Stereo\n")
        raise AssertionError(f"unexpected tool {tool}")


class VideoPipelineTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = pathlib.Path(self.temp.name)
        self.capture = root / "capture"
        (self.capture / "video").mkdir(parents=True)
        (self.capture / "video" / "source.mp4").write_bytes(b"\x00\x00\x00\x18ftypmp42" + b"\x00" * 64)
        self.work = root / "work"
        self.work.mkdir()
        self.stages = []

    def run_pipeline(self, tools):
        return vp.prepare_video_dataset(tools, self.capture, self.work, lambda stage, detail: self.stages.append((stage, detail)))

    def assertCode(self, code, tools):
        with self.assertRaises(vp.WorkerError) as raised:
            self.run_pipeline(tools)
        self.assertEqual(raised.exception.code, code)
        return raised.exception

    def test_happy_path_reports_stages_counts_and_sparse_initialisation(self):
        tools = FakeTools()
        result = self.run_pipeline(tools)
        self.assertEqual([stage for stage, _ in self.stages], ["extracting_frames", "solving_poses"])
        self.assertEqual(result["frames"]["extracted"], 120)
        self.assertEqual(result["frames"]["selected"], vp.plan_frames(20.0)[0])
        self.assertEqual(result["sfm"]["registeredViews"], result["frames"]["selected"])
        self.assertEqual(result["sfm"]["registrationRatio"], 1.0)
        self.assertTrue(result["sfm"]["sparsePointsInitialisation"])
        self.assertIn("COLMAP 3.9.1", result["sfm"]["toolVersion"])
        self.assertTrue((result["dataset"] / "transforms.json").is_file())
        self.assertFalse((self.work / "raw_frames").exists(), "the oversampled raw frames are removed after selection")
        extract = next(call for call in tools.calls if call[0] == "ffmpeg")
        self.assertIn("fps=", extract[extract.index("-vf") + 1])
        sfm = next(call for call in tools.calls if call[0] == "ns-process-data")
        self.assertEqual(sfm[1], "images")
        self.assertIn("colmap", sfm)

    def test_blurry_and_duplicate_frames_are_dropped_before_colmap(self):
        # 40 sharp unique frames, 20 heavily blurred, 20 exact repeats of the last sharp frame.
        frames = [(i, 0) for i in range(40)] + [(100 + i, 6) for i in range(20)] + [(39, 0)] * 20
        tools = FakeTools(probe=probe_json(duration=10.0), frames=frames)
        result = self.run_pipeline(tools)
        stats = result["frames"]
        self.assertGreaterEqual(stats["blurDropped"], 20)
        self.assertGreaterEqual(stats["duplicateDropped"], 20)
        self.assertEqual(stats["selected"], 40)
        submitted = len(list((self.work / "selected_frames").glob("*.jpg")))
        self.assertEqual(submitted, 40)

    def test_extraction_never_samples_faster_than_the_footage(self):
        tools = FakeTools(probe=probe_json(duration=8.0).replace('"30/1"', '"12/1"'))
        self.run_pipeline(tools)
        extract = next(call for call in tools.calls if call[0] == "ffmpeg")
        self.assertTrue(extract[extract.index("-vf") + 1].startswith("fps=12.000000,"))

    def test_unreadable_video_is_typed(self):
        error = self.assertCode("video_unreadable", FakeTools(probe_returncode=1))
        self.assertIn("ffprobe", error.message)

    def test_file_without_video_stream_is_unreadable(self):
        self.assertCode("video_unreadable", FakeTools(probe=probe_json(streams=[{"codec_type": "audio"}])))

    def test_decode_failure_with_no_frames_is_unreadable(self):
        self.assertCode("video_unreadable", FakeTools(ffmpeg_returncode=1, frames=[]))

    def test_short_video_is_typed(self):
        error = self.assertCode("video_too_short", FakeTools(probe=probe_json(duration=1.2)))
        self.assertEqual(error.details["minSeconds"], vp.MIN_DURATION_SECONDS)

    def test_overlong_video_is_refused(self):
        self.assertCode("video_unreadable", FakeTools(probe=probe_json(duration=vp.MAX_DURATION_SECONDS + 60)))

    def test_too_few_frames_extracted_is_too_short(self):
        self.assertCode("video_too_short", FakeTools(frames=[(i, 0) for i in range(10)]))

    def test_uniformly_soft_footage_is_too_blurry(self):
        frames = [(i, 15) for i in range(100)]
        self.assertCode("frames_too_blurry", FakeTools(frames=frames))

    def test_blur_leaving_fewer_than_the_floor_is_too_blurry(self):
        # 23 sharp + 22 blurred: the median is a sharp frame, the 22 blurred are dropped, 23 < the floor of 24.
        frames = [(i, 0) for i in range(23)] + [(50 + i, 6) for i in range(22)]
        error = self.assertCode("frames_too_blurry", FakeTools(probe=probe_json(duration=10.0), frames=frames))
        self.assertLess(error.details["selected"], vp.MIN_VIEWS_FOR_RECONSTRUCTION)

    def test_repeats_leaving_fewer_than_the_floor_is_too_short(self):
        frames = [(i, 0) for i in range(12)] + [(11, 0)] * 18
        error = self.assertCode("video_too_short", FakeTools(probe=probe_json(duration=10.0), frames=frames))
        self.assertGreaterEqual(error.details["duplicateDropped"], 17)

    def test_colmap_failure_is_sfm_failed(self):
        error = self.assertCode("sfm_failed", FakeTools(sfm_returncode=1))
        self.assertIn("COLMAP", error.details["tail"])

    def test_registered_floor_is_enforced(self):
        error = self.assertCode("sfm_failed", FakeTools(sfm_registered=vp.MIN_VIEWS_FOR_RECONSTRUCTION - 1))
        self.assertEqual(error.details["registeredViews"], vp.MIN_VIEWS_FOR_RECONSTRUCTION - 1)

    def test_registration_ratio_gate(self):
        selected = vp.plan_frames(20.0)[0]
        registered = int(selected * (vp.MIN_REGISTRATION_RATIO - 0.1))
        self.assertGreaterEqual(registered, vp.MIN_VIEWS_FOR_RECONSTRUCTION)
        error = self.assertCode("sfm_failed", FakeTools(sfm_registered=registered))
        self.assertLess(error.details["registrationRatio"], vp.MIN_REGISTRATION_RATIO)

    def test_exactly_enough_registration_passes(self):
        selected = vp.plan_frames(20.0)[0]
        registered = int(selected * vp.MIN_REGISTRATION_RATIO) + 1
        result = self.run_pipeline(FakeTools(sfm_registered=registered))
        self.assertGreaterEqual(result["sfm"]["registrationRatio"], vp.MIN_REGISTRATION_RATIO)

    def test_missing_or_multiple_sources_are_refused(self):
        (self.capture / "video" / "source.mp4").unlink()
        self.assertCode("video_unreadable", FakeTools())
        (self.capture / "video" / "source.mp4").write_bytes(b"x")
        (self.capture / "video" / "source.mov").write_bytes(b"x")
        self.assertCode("video_unreadable", FakeTools())

    def test_error_detail_is_machine_readable(self):
        error = vp.WorkerError("sfm_failed", "msg", details={"a": 1})
        self.assertEqual(error.detail(), {"code": "sfm_failed", "message": "msg", "details": {"a": 1}})

    def test_frame_plan_is_bounded(self):
        self.assertEqual(vp.plan_frames(3.0)[0], vp.MIN_TARGET_FRAMES)
        self.assertEqual(vp.plan_frames(600.0)[0], vp.MAX_TARGET_FRAMES)
        target, extract = vp.plan_frames(20.0)
        self.assertGreater(extract, target)
        self.assertLessEqual(extract, vp.MAX_EXTRACTED_FRAMES)


if __name__ == "__main__":
    unittest.main()
