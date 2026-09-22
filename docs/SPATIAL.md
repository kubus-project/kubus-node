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
