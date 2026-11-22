# Spatial processing

Raw `kubus.capture/1` packages are private/local. A package contains RGB frames, tracked poses, camera intrinsics, timestamps, and optional depth/confidence files plus capture metadata. No raw package enters Kubo's public pin policy, publication, or reward accounting automatically.

The generic runtime accepts `spatial.reconstruct`, `spatial.optimize`, and `spatial.generate_preview`. Reconstruction is currently implemented by the optional worker; unsupported job types and unsupported CPU/no-CUDA hosts fail with explicit codes. Jobs remain queryable after failure or restart.

Successful output is expressed as renderer-neutral `kubus.spatial/1`:

- `type` (`gaussianSplat` initially; existing model3d GLB/GLTF remains separate and compatible)
- artwork/optional marker identity
- capture provenance, capture time and authorized capturer
- preview/mobile/archive variants with CID, bytes, MIME, format and storage class
- transform and optional viewer defaults

The schema includes an independent spatial ID and timestamp, so an artwork or marker can hold many object versions over time.

Remote encrypted input CIDs are private-compute ciphertext records. Unpublished output CIDs are unlisted and never canonical public objects, but ordinary Kubo output is not cryptographically private from someone who knows the CID. Publication groups preview/mobile/archive variants beneath one spatial object version with roles `spatial_preview`, `spatial_mobile`, and `spatial_archive`. Missing variants are explicit; they are not fabricated from one file.

The worker pins Nerfstudio `1.1.5` and its declared compatible gsplat `1.4.0` on NVIDIA/CUDA. It exports a Gaussian PLY into the job output directory. The agent validates paths, imports bytes through Kubo, creates the manifest, and retains the source capture privately.

The Flutter viewer bundles Spark `2.1.0` and Three.js `0.185.1`. It provides orbit/zoom viewing with mobile/public variants and node/public fallback. This is not true tracked AR. Camera-aligned spatial overlays require a future native AR renderer integration; no transparent WebView-over-camera approximation is used.

## Video intake

A capture is either a posed-frame package (`frames.json` plus RGB frames, as above) or a **video package**: exactly one file at `video/source.<mp4|mov|m4v|webm|mkv>` and no `frames.json`. The package kind is decided from the files, so a video capture needs no extra metadata.

Commit and job creation check the video at the Node boundary: size bounds (64 KiB to 4 GiB), the container signature and, for the MP4 family, the movie header, which also proves the upload was not truncated and gives the duration (3 s to 20 min). The worker repeats the checks with ffprobe and is authoritative for decodability.

A video is too large for the 128 MiB streaming-upload request, so it is imported from the Node's own disk:

```sh
docker cp clip.mp4 kubus-node-kubus-node-agent-1:/var/lib/kubus-node/data/imports/clip.mp4
docker exec kubus-node-kubus-node-agent-1 node dist/src/index.js capture import-video \
  /var/lib/kubus-node/data/imports/clip.mp4 --artwork <artworkId> --marker <markerId> --process
```

A running Node performs the import (the file must sit in `<data>/imports` or a directory listed in `KUBUS_IMPORT_DIRS`); with no running Node the command imports the file directly from wherever it is. `--process` queues the reconstruction. Importing the same file for the same artwork and marker twice returns the capture it already made. The capture is private like any other; the original file name is not stored.

`spatial.reconstruct` on a video capture runs with `input.mode: "video"`. The Node hands the capture directory to the worker, which:

1. probes the video (`video_unreadable`, `video_too_short`),
2. extracts an oversampled set of frames with ffmpeg (about 2.5 times the target, never above the source frame rate),
3. scores each frame by the variance of its Laplacian, drops blurry frames (below half the median) and near-duplicates, and keeps the sharpest frame per time bucket (`frames_too_blurry` when fewer than 24 usable frames remain),
4. runs `ns-process-data images` (COLMAP, GPU) over the kept frames, which also writes the sparse point cloud that initialises splatfacto,
5. refuses the run when COLMAP registers fewer than 24 views or fewer than 60 percent of the submitted frames (`sfm_failed`),
6. trains with `ns-train splatfacto` and exports the Gaussian PLY exactly as for posed frames.

The job reports the truthful stages `extracting_frames`, `solving_poses` and `training`; the worker publishes its current stage in `worker-progress.json` in the job's output directory, which the Node follows while its one request is open. Typed worker failures reach the operator as the job error code with a message and counts (never tool output). The manifest records how the scene was derived under `captureProvenance.derivation` (video facts, frame selection counts, COLMAP version and registration counts, splat count); that block is private provenance and is not part of the public manifest.

Camera poses from COLMAP have arbitrary scale and orientation, which is fine for an object viewer; placing the splat in the world would need an alignment step that does not exist yet.

The thresholds are environment variables of the worker: `KUBUS_VIDEO_MIN_SECONDS`, `KUBUS_VIDEO_MAX_SECONDS`, `KUBUS_VIDEO_MIN_REGISTRATION_RATIO`, `KUBUS_VIDEO_BLUR_RATIO`, `KUBUS_VIDEO_MIN_MEDIAN_SHARPNESS`, `KUBUS_VIDEO_DUPLICATE_DIFF`, `KUBUS_VIDEO_FRAMES_PER_SECOND`, `KUBUS_VIDEO_MIN_TARGET_FRAMES`, `KUBUS_VIDEO_MAX_TARGET_FRAMES`.

Two operational notes. The Node-to-worker request waits for the whole reconstruction, so it uses its own HTTP dispatcher without a headers timeout (Node's default is five minutes) and a 27 hour ceiling. The worker runs as root, so it gives the job's output tree back to the Node's user when it finishes; otherwise the Node's cleanup cannot delete it and every later job is refused as `worker_cleanup_pending`.

`scripts/render_synthetic_orbit.py` (CC0) renders a synthetic orbit video of a procedural 3D flower for testing, and `scripts/smoke_video_intake.sh` runs the whole chain against a running stack.

## Future delivery gate

The cross-repository master roadmap is
`art.kubus/docs/PRODUCT_UX_SEO_PROGRAM.md` (Wave 12), with the bounded package
in `art.kubus/docs/AGENT_EXECUTION_PLAN.md` and target detail in
`art.kubus/docs/SPATIAL_DELIVERY_ROADMAP.md`. After real Ljubljana field
sessions, implement master reconstruction → HOT small preview → WARM
streamed/paged runtime LOD → COLD canonical archive PLY. The archive is for
preservation/reprocessing, not automatic normal viewing. Current worker output
and viewer `blob()` loading do **not** satisfy that target. Future work needs
real `spatial.optimize` derivatives, direct Spark URLs, scoped viewer
capabilities where auth requires them, Range/ETag/cache behaviour,
capacity-aware replication and source/work-directory retention. This section
is a roadmap, not a claim that derivatives or streaming are shipped.
