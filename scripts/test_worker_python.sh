#!/usr/bin/env bash
# Runs the spatial worker's Python test suites (face masking, photo and video pipelines, scene frame, job
# control, GPU tier) inside the worker image. They need no GPU and no network, and they are the only tests of the
# face detector rules (pinned weights, thresholds that can only get more eager, exclude boxes, the review list).
#
#   scripts/test_worker_python.sh [worker-image]   # default: the image `docker build spatial-worker` makes
#
# CI passes the image its `docker compose -p kubus-worker-ci build` step just made (kubus-worker-ci-kubus-spatial-worker),
# so the large nerfstudio-based image is built once per workflow, not twice.
#
# The test files are deliberately not copied into the image: the source (modules, weights and tests) is mounted
# read-only and copied inside, so the run tests the checked-out source on the image's Python and libraries.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
src="$(cd "$here/../spatial-worker" && pwd)"
image="${1:-}"
if [ -z "$image" ]; then
  image="$(docker build --quiet "$src")"
elif ! docker image inspect "$image" >/dev/null 2>&1; then
  # Never let `docker run` try to pull a name that was meant to be a local build.
  echo "worker image '$image' does not exist locally; build it first (docker compose -p kubus-worker-ci build kubus-spatial-worker)" >&2
  exit 1
fi
# MSYS_NO_PATHCONV keeps Git Bash on Windows from rewriting the container paths.
MSYS_NO_PATHCONV=1 docker run --rm --network none --entrypoint sh -v "$src:/src:ro" "$image" -c '
  set -e
  rm -rf /tmp/worker-tests
  mkdir /tmp/worker-tests
  cp -r /src/. /tmp/worker-tests/
  cd /tmp/worker-tests
  python -m unittest test_face_mask test_photo_pipeline test_video_pipeline test_scene_frame test_job_control test_gpu_tier
'
