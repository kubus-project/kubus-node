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

## Delivery

A scene has up to three representations, each with a fixed storage class: a small SPZ preview (`spatial_preview`, hot), a paged RAD runtime tree (`spatial_mobile`, warm, a flat bundle: `rootCid` + `entrypoint` + `fileCount`) and the reconstruction PLY (`spatial_archive`, cold). Preview and runtime are derived from the archive by pinned tools (Niantic spz v3.0.0, Spark build-lod from Spark 2.1.0) in the master's own coordinate frame, and can be regenerated from the preserved master without retraining (`spatial.optimize`, `spatial.generate_preview` with a `spatialId`). A failed derivative never loses the master.

The GUI viewer never receives the GUI credential on a content request: it asks for a viewer ticket and loads same-origin capability URLs (`/gui/content/<token>/<file>`, GET/HEAD, byte ranges, short idle and absolute expiry). It draws the preview first, then the runtime tree; the archive opens only when asked for by name. Status, dependencies and open items: `docs/spatial-delivery-integration.md`.
