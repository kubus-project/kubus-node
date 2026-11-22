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

Camera poses from COLMAP have arbitrary scale and orientation; the worker estimates an upright viewer transform and an optional floater crop from them (see "Viewer orientation and floater crop"). Placing the splat in the world would need a further alignment step that does not exist yet.

The thresholds are environment variables of the worker: `KUBUS_VIDEO_MIN_SECONDS`, `KUBUS_VIDEO_MAX_SECONDS`, `KUBUS_VIDEO_MIN_REGISTRATION_RATIO`, `KUBUS_VIDEO_BLUR_RATIO`, `KUBUS_VIDEO_MIN_MEDIAN_SHARPNESS`, `KUBUS_VIDEO_DUPLICATE_DIFF`, `KUBUS_VIDEO_OVERSAMPLE`, `KUBUS_VIDEO_MAX_LONG_SIDE`, `KUBUS_VIDEO_FRAMES_PER_SECOND`, `KUBUS_VIDEO_MIN_TARGET_FRAMES`, `KUBUS_VIDEO_MAX_TARGET_FRAMES`. `docker-compose.yml` forwards each of them to the `kubus-spatial-worker` service with the worker default, so setting one in the shell or in `.env` next to the compose file is enough; an unparsable value falls back to the default.

Two operational notes. The Node-to-worker request waits for the whole reconstruction, so it uses its own HTTP dispatcher without a headers timeout (Node's default is five minutes) and a 33 hour ceiling (the worker's own limits add up to 32 hours in the worst case: 1 hour frame extraction, 3 hours pose solving, 24 hours training, 2 hours export, 2 hours for the optional floater-crop export). The worker runs as root, so it gives the job's output tree back to the Node's user when it finishes; otherwise the Node's cleanup cannot delete it and every later job is refused as `worker_cleanup_pending`.

`scripts/render_synthetic_orbit.py` (CC0) renders a synthetic orbit video of a procedural 3D flower for testing, and `scripts/smoke_video_intake.sh` runs the whole chain against a running stack.

## Photo intake

A capture of plain photographs has no camera poses: no ARCore tracking, no intrinsics. A **photo package** is a set of JPEG or PNG files directly under `photos/` and no `frames.json`; a **mixed package** also holds exactly one `video/source.<ext>`. The package kind (`photos`, `video`, `mixed`, or `frames`) is decided from the files, and `frames.json` wins if present.

```sh
# the photos sit in <data>/imports/<piece>/ (docker cp -r); the Node imports them and queues the job
kubus-node capture import-photos /var/lib/kubus-node/data/imports/lala \
  --artwork <artworkId> --marker <markerId> --captured-at 2026-08-17T06:00:00Z --process --floater-crop
```

Boundary checks (Node, `src/captures/photoPackage.ts`; headers only, never whole files): 8 to 400 photos, 16 KiB to 120 MiB each, a real JPEG or PNG signature that agrees with the extension, a readable size header (short side at least 480 px, long side at most 20,000 px, at most 200 megapixels), a complete tail (a JPEG ends with EOI, a PNG with IEND, which catches a truncated upload), and no symbolic links. Sub-directories and files that are not images are skipped and counted in the import answer (`skippedFiles`). Photos are streamed into the capture under constant names (`photos/00001.jpg`); the original file names, which a phone makes personal, are never stored and never reach a path. The same directory imported twice for the same artwork and marker returns the capture it already made. `--captured-at` is the capture time of the photos (default: the oldest file time; pass it explicitly, because it feeds the grant rule `validFrom <= capturedAt`); `--captured-by` records a free-text operator label and stays unset until the photographer is confirmed. A running Node needs the directory under `<data>/imports` or `KUBUS_IMPORT_DIRS`.

The worker (`spatial-worker/photo_pipeline.py`) decodes every photo, bakes its EXIF orientation into the pixels (COLMAP and Nerfstudio ignore the tag), downscales to 2048 px on the long side, and writes a clean JPEG under a constant name that keeps only the lens facts COLMAP uses as a focal-length prior. It then runs COLMAP in stages (feature extraction, exhaustive matching, mapper). `ns-process-data images` assumes a single camera for the whole folder, and a photo set usually mixes devices, lenses and crops, so the stages are run directly (one camera per distinct size and lens, as COLMAP groups them) and Nerfstudio's own `colmap_to_json` writes `transforms.json` and `sparse_pc.ply`. The largest reconstructed model is used. The gates are the video path's, from one shared function: at least 24 registered views and at least 60 percent of the submitted photos registered, else `sfm_failed` with the counts; fewer than 8 decodable photos is `photos_unreadable`. Training and export are unchanged.

Photo sets are small, so the floor and ratio can be tuned separately from the video gate: `KUBUS_PHOTO_MIN_REGISTERED_VIEWS` (24), `KUBUS_PHOTO_MIN_REGISTRATION_RATIO` (follows `KUBUS_VIDEO_MIN_REGISTRATION_RATIO`, 0.6), `KUBUS_PHOTO_MIN_COUNT` (8) and `KUBUS_PHOTO_MAX_LONG_SIDE` (2048); `docker-compose.yml` forwards them like the video thresholds. A set of fewer than 24 photos cannot pass the default floor; lowering it is an operator decision, and the run record carries it: the `sfm` provenance holds `minRegisteredViews`, `minRegistrationRatio` and `gateLowered` (true when either is below the default), so a below-gate record is visible as one.

## Face masking

People who happen to stand in front of a mural must not end up in a splat. Photos and video frames are masked before pose solving and training, with a detector whose weights are pinned and checksummed in the worker image. **A posed-frame package (an app capture made with ARCore poses) is not masked by this step**: its frames never pass through the worker's intake, so its record says so (`faceMasking: { ran: false, reason: "posed_frames_not_masked" }`) instead of staying silent, and it must not be treated as masked.

- **Detector** (`spatial-worker/face_mask.py`): YuNet, `face_detection_yunet_2023mar.onnx` from OpenCV Zoo commit `48b10fa5`, run through OpenCV's `cv2.FaceDetectorYN`. Code and weights are MIT, the network was trained with BSD-3-Clause libfacedetection.train (`spatial-worker/models/`, `docs/THIRD_PARTY_LICENSES.md`). The weights file is vendored, verified against its SHA-256 when the image is built and again before every use; a missing or altered file is `face_masking_failed`, never a silent "no faces".
- **Tuned for recall.** A missed face is worse than a patch over a flower. Detection runs at five whole-image scales plus overlapping native-resolution tiles (a face 20 px wide in a 5000 px photo is seen at that size), with a score threshold of 0.4 (the detector's default is 0.9). Detections between 0.4 and 0.7 must also have a face-shaped landmark layout in the frame of the eye line (so a tilted or sideways head passes and rough-wall texture does not), and a wide detection (above 12 percent of the photo's short side) is only believed at 0.9 with that layout. Boxes of the same face found by several passes are kept once, never united. Each region is grown generously (45 percent each side, 70 percent up, 40 percent down) and filled with **one flat colour** (the region's median), which cannot be undone. Recall is reviewed, not guaranteed: there is no labelled benchmark, and the weakest case is a large, close face (above 12 percent of the short side), which is accepted only at score 0.9 and above with a face-shaped layout, because the coarse passes that see large faces also score plain walls at 0.8. For the six Head of Flowers sets the threshold was relaxed to 0.6 for large faces on all 170 raw photos and every extra detection was looked at (see the build report): none was a person. A new capture needs the same contact-sheet review.
- **A reviewed manual list refines it.** `add` boxes are masked as given. `exclude` entries drop detections that lie inside them (a painted face, sunflower centre or wall speck that is part of the artwork, which is not masked): the detection's centre must be inside the box and at least half of its area. One tight box per painted feature, never a box over a region of the photo: `{"box": [x0, y0, x1, y1], "expectStrong": 0, "note": "..."}` (a bare `[x0, y0, x1, y1]` expects 0). A real face inside an exclude box would stay unmasked, so the run counts the near-certain detections (score 0.9 or more with a face-shaped layout) each box swallowed and **stops without writing a report** unless the count equals `expectStrong`, which the reviewer sets after looking at the image (a painted head the detector is sure of is `1`; a person walking into a box fails the run). A box over a third of the image needs `"allowLarge": true`. `--discover` lists the mismatches instead of stopping, and deletes the report so a discovery run cannot be imported. Boxes are fractions of the upright image, so a list survives resizing; the list is private and per image.
- **Colour.** A photo with an ICC profile other than sRGB (an iPhone's Display P3) is converted to sRGB pixels and the copy carries an sRGB profile, so the reconstruction does not read P3 values as sRGB. Location, thumbnail, XMP and the multi-picture (gain map) data are not carried into the copy.
- **Provenance records counts, never coordinates.** The manifest, which is pinned and can be published, carries in `captureProvenance.derivation.faceMasking` and `processing.faceMasking` only, per part (`photos`, `video`): the source (`worker` or `premasked`), `attestation`, detector, model, weights SHA-256, whether those weights are the pinned ones (`weightsPinned`), score threshold, image count, total regions and images with regions. The region count of each image and the manual add/exclude counts are **not** in the manifest: for photos masked by the worker they are kept in the Node's private job record (`maskingDetail`), for premasked photos in the private capture record. A capture that is not masked records `{ ran: false }`.
- **`premasked` is operator-attested.** The Node binds the report to the imported files by SHA-256, so it cannot be attached to other images, but it did not run the detector: a hand-written report that names the files' hashes and claims zero regions would be accepted. The record says so (`attestation: "operator_report"`) and says whether the report names the pinned weights (`weightsPinned`); a report naming other weights is recorded, not refused. Use the worker mode (the Node masks) when the operator is not the person who vouches for the report.

Where masking happens is decided at import and stored on the capture (`faceMasking`):

| Mode | When | What happens |
| --- | --- | --- |
| `premasked` | The photo directory holds a `kubus-face-masking.json` report written by `python face_mask.py mask <in> <out>` | The report names every masked file by SHA-256 (a report for other files is refused: `face_masking_report_mismatch`), the unmasked originals never enter the capture store, and the record carries the operator report. |
| `worker` | Default for a capture bound to an artwork (public art); `--mask-faces` for one without | The job asks the worker (`input.maskFaces: { photos, video }`) to mask every photo and video frame as the first step. The unmasked source files stay in the private capture store. The Node refuses a worker that does not advertise `faceMasking`, and fails the job (`face_masking_failed`, nothing imported) if the worker's answer does not report masking for every part it was asked to mask. |
| `none` | `--no-mask-faces`, or no artwork and no flag | Recorded as `ran: false`. |

Paired clients cannot declare their own captures masked; `faceMasking` in uploaded metadata is discarded. Masked copies of a directory, with a report and contact sheets for a human to check, come from the worker image:

```sh
docker run --rm --entrypoint python -v <in>:/in:ro -v <out>:/out kubus-node-kubus-spatial-worker:latest \
  /worker/face_mask.py mask /in /out/<piece> [--manual /out/_manual/<piece>.json] [--contact /out/_contact/<piece>]
```

Detection is not perfect: look at the contact sheets before training, and fix a miss with a `--manual` list. Masking covers faces; other personal data in a photo (number plates, a name on a wall, a body) is not detected.

An earlier record that was reconstructed from unmasked images is retired with `kubus-node spatial supersede <oldId> --by <newId>`: the record is marked `superseded` (kept as history, and `superseded` is terminal: the publish route refuses it and nothing sets it back), the Node releases the pins it created for its manifest and splat, and the Node's own content endpoint answers 410. It never runs garbage collection, never removes a pin the Node did not create, and refuses a replacement that belongs to another artwork or is not newer. The stored photos of the superseded capture are not deleted by this command.

**Unpinned is not deleted.** The blocks of a superseded record stay in the Kubo block store until they are collected, and Kubo's own gateway (`:8080`, and the one the stock `docker-compose.yml` publishes) serves an unpinned block that is still there; once the Node is connected to a swarm (the compose file publishes swarm port 4001 and runs Kubo online) so does bitswap. The `supersede` answer therefore reports `blocksStillStored`, the agent logs a warning at start while any superseded content is still stored, and **`kubus-node spatial purge-superseded`** removes exactly those blocks (children first, then the root; Kubo refuses a pinned block, so anything another record still holds is kept and reported; it is not a garbage collection and touches nothing outside superseded records). Run it before enabling peering, and repeat a range request against the gateway for an old archive CID afterwards: it must fail. The earlier captures that still hold the unmasked photos (`capture delete`) and any state backup taken before the masking are separate copies this command does not touch.

A revision whose reason is `face_masking` carries **no link to the unmasked record**: its manifest has no `previousSpatialId`, `previousManifestCid` or `previousCaptureId` (it keeps `number`, `reason` and `note`), because a manifest anyone may read must not name an unmasked record, its manifest CID or the capture that still holds the unmasked photos.

## Mixed captures and spatial revisions

A video that arrives after the photos does not change the photo capture or its spatial record:

```sh
kubus-node capture add-video <photoCaptureId> /var/lib/kubus-node/data/imports/later.mp4 \
  --captured-at 2026-12-02T09:00:00Z --process
```

builds a NEW `mixed` capture holding the photo capture's photos and the video, with `derivedFrom: { captureId }`, and the photo capture stays exactly as it was. (`import-photos <dir> --video <file>` makes a mixed capture in one step.) The worker solves photos and video frames in one COLMAP run: photos keep their per-lens cameras, the video frames share one camera (a second `feature_extractor` pass with `single_camera 1` into the same database), and the gate counts every submitted image. `registeredPhotos` and `registeredVideoFrames` are reported separately.

A reconstruction of the new capture produces a NEW spatial record; nothing is overwritten. The job links it to the record it revises: an explicit `previousSpatialId` (`capture process <captureId> --previous <spatialId>`) or, when the capture has `derivedFrom`, the newest record of that capture. The artwork must match (`previous_spatial_artwork_mismatch` otherwise; an unknown id is `previous_spatial_not_found`). The manifest always carries the revision block below, for the backend grant and revision model to bind to:

| Field | Meaning |
| --- | --- |
| `id` | The spatial record id, unique per revision. A grant or publication binds to this. |
| `artworkId`, `markerId` | The artwork the record belongs to; a revision must match its predecessor's artwork. |
| `captureId` | The private capture this record was reconstructed from (dropped from a public manifest). |
| `capturedAt` | The earliest capture time of any input (a mixed capture takes the earlier of photos and video), so a `validFrom <= capturedAt` rule is conservative. It is the start of the shoot, not of the finished work: a mural photographed over several days, or in unfinished states, carries the time of its first photo. The per-medium times are on the capture record (`mediaCapturedAt`). |
| `capturedBy` | Optional operator label from the capture (opt-in at publication). |
| `revision.number` | 1 for the first record of an artwork, previous number + 1 after that. |
| `revision.reason` | `initial`, `video_added` (the capture was derived from the previous record's capture), `face_masking` (the previous record was reconstructed from unmasked images and this one from masked ones) or `resolve`. |
| `revision.note` | Optional free text from `capture process --revision-note` (for example the provenance corrections made with the revision). |
| `revision.previousSpatialId` | The record this one revises. Absent for revision 1. |
| `revision.previousManifestCid` | CID of the previous record's manifest: the link is content-addressed. |
| `revision.previousCaptureId` | The capture of the previous record. |
| `revision.inputs` | `{ captureKind, photos?, video? }`: what this record was reconstructed from. |

Suggested backend binding: a grant authorises (artwork, methods, territory, window); a publication of revision N is checked against the grant in force at publication time, using the `capturedAt` of that revision, and records `id` and `revision.number`. Withdrawing or suspending the revision-1 record does not touch revision 2 and vice versa, and the previous record stays reachable through `previousSpatialId`. `captureProvenance.derivation` (private) records the inputs, COLMAP counts and timings; a public manifest must drop `captureProvenance` as before.

## Viewer orientation and floater crop

COLMAP output has an arbitrary orientation, centre and scale. For every COLMAP-derived scene (video, photos, mixed) the worker estimates, in the coordinate frame the splat file is written in (cameras and sparse points are first mapped through `dataparser_transforms.json`; `spatial-worker/scene_frame.py`):

- **up**: the mean of the cameras' up axes; when they disagree (mean resultant length below 0.6, for example rolled photos), the normal of the dominant plane of the sparse points, signed by the cameras, but only when the cameras look at that plane obliquely. **That fallback is a heuristic.** It assumes the dominant plane is horizontal (a floor or table). View geometry cannot prove that: a wall mural photographed obliquely with rolled cameras gives the same picture, and then the plane normal is horizontal, so "up" would be sideways. The fallback is therefore never reported as a trusted answer: its confidence is capped at 0.5, below the 0.6 trusted level, and `processing.orientation.trusted` is `false` for it (and for `camera_up_weak` and `assumed`); only a consensus of the cameras' own up axes is `trusted: true`. Cameras looking face-on at the plane keep the weak mean camera up (`camera_up_weak`); else +Z is assumed. The method, a 0 to 1 confidence and `trusted` are recorded. **An answer that is not trusted never rotates the scene:** the viewer transform is then a centring and uniform scale only (`rotationApplied: false`, no yaw from the front estimate), so a mural shot obliquely with rolled cameras opens unrotated rather than sideways; check the viewer image of any record whose orientation is not trusted.
- **front**: the horizontal direction from the subject towards the cameras, when the cameras cover one side (resultant length at least 0.4); a full orbit has no front and keeps its yaw.
- **subject box**: the 2nd to 98th percentile box of the sparse points, grown by 35 percent (never by less than 15 percent of the largest side, so a flat mural is not cut to a sliver).

`manifest.transform.matrix` is 16 numbers in **column-major** order (three.js `Matrix4.fromArray`) mapping splat-file coordinates to viewer coordinates: right-handed, +Y up, the subject centred on the origin, its largest dimension two units across, its front facing +Z (the viewer camera starts at +Z). `transform.up` is the up vector in splat coordinates and `transform.method` how it was found; `processing.orientation` holds method, confidence, front, centre and counts. The Node GUI viewer reads the manifest and passes `transform` to `window.loadSpatial(url, transform)`; the vendored bundle carries one local patch for that (see its header comment; re-apply it when the bundle is replaced by a fresh build of the app viewer). A record without a transform opens as before. The app and web viewers must apply the same `matrix`; until they do they show the file's own orientation.

The **floater crop** is optional (per job `floaterCrop: true`, `--floater-crop` on the CLI, or `KUBUS_SPATIAL_FLOATER_CROP=1` as the worker default). It re-exports the trained splat with `ns-export gaussian-splat --obb-center/--obb-rotation/--obb-scale` set to the subject box (axis-aligned in the splat frame) and uses that file as the archive variant. `processing.floaterCrop` records `applied`, the box (`min`, `max`, `method: sparse_point_percentile`, `percentiles`, `margin`, `frame: splat`) and the splat counts before and after. The uncropped export stays in the job's output directory only until the job is cleaned up; if the full-scene archive matters, run without the crop. A crop that cannot be applied is recorded as `applied: false` with a reason, never silently skipped.

Orientation is a convenience: if it cannot be computed the run still completes, with `provenance.orientation.method = "unavailable"` and no transform.

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
