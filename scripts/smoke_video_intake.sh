#!/usr/bin/env bash
# Container smoke test for native video intake. Needs a running stack started with
#   docker compose --profile spatial up -d --build
# and an NVIDIA GPU. It renders a short synthetic clip with the worker image
# (scripts/render_synthetic_orbit.py, CC0), imports it with
# `kubus-node capture import-video --process`, and waits for the reconstruction.
#
#   scripts/smoke_video_intake.sh [compose-project]   # default project: kubus-node
#
# Set KUBUS_SPATIAL_MAX_ITERATIONS=1500 on the worker for a run of a few minutes.
set -euo pipefail
project="${1:-kubus-node}"
agent="${project}-kubus-node-agent-1"
worker_image="${KUBUS_WORKER_IMAGE:-${project}-kubus-spatial-worker}"
here="$(cd "$(dirname "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

docker run --rm --gpus all -v "$here:/s:ro" -v "$work:/m" "$worker_image" \
  python /s/render_synthetic_orbit.py --out /m/smoke-orbit.mp4 --seconds 8 --fps 12 --width 640 --height 360
docker cp "$work/smoke-orbit.mp4" "$agent:/var/lib/kubus-node/data/imports/smoke-orbit.mp4"
result="$(docker exec "$agent" node dist/src/index.js capture import-video \
  /var/lib/kubus-node/data/imports/smoke-orbit.mp4 --artwork smoke-artwork --marker smoke-marker --process)"
echo "$result"
job="$(printf '%s' "$result" | sed -n 's/.*"jobId": "\([^"]*\)".*/\1/p')"
[ -n "$job" ] || { echo "no job was queued" >&2; exit 1; }

poll='fetch("http://127.0.0.1:8787/gui/api/jobs/"+process.env.JOB,{headers:{authorization:"Bearer "+process.env.NODE_GUI_TOKEN}}).then(r=>r.json()).then(j=>{console.log(j.data.state+" "+j.data.stage+" "+(j.data.error?j.data.error.code:""))})'
for _ in $(seq 1 240); do
  state="$(docker exec -e JOB="$job" "$agent" node -e "$poll")"
  echo "$state"
  case "$state" in
    completed*) echo "video intake smoke: OK"; exit 0 ;;
    failed*|cancelled*) echo "video intake smoke: FAILED ($state)" >&2; exit 1 ;;
  esac
  sleep 5
done
echo "video intake smoke: timed out" >&2
exit 1
