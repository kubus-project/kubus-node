# Spatial delivery pipeline: handoff (work in progress)

Status as of 2026-10-09. This branch is a **draft checkpoint**, not a finished change. It adds the
derivative pipeline foundation; the viewer streaming, installer GPU path, pin policy, app and backend
work are not done. Delete this file when the work lands.

## Goal

```
capture -> GPU reconstruction -> MASTER PLY (archive, cold)
                               -> preview SPZ (hot)
                               -> runtime RAD bundle (warm, paged LOD)
        -> kubus.spatial manifest -> progressive viewer -> hot/warm/cold pin policy
```

The full PLY is an archival source, never the normal viewing format.

## Done on this branch (typechecks; existing 527 tests pass; new code has no tests yet)

- `src/spatial/models.ts`: a variant is a single file (`cid`) or a flat immutable bundle
  (`rootCid` + `entrypoint` + `fileCount`), mutually exclusive. Storage class is fixed by role.
  Legacy single-file manifests stay valid.
- `src/spatial/derivativeImport.ts`: validates and imports worker output (files and bundles) into Kubo.
- `src/spatial/spatialRecords.ts`: record store, manifest rewrite per derivative, per-scene lock,
  derivative status (`ready|running|failed|missing`).
- `src/jobs/jobRuntime.ts`: reconstruct -> master saved and record created -> preview -> runtime.
  A derivative failure never loses the master. A crash resumes from `job.checkpoint.spatialId`.
  `spatial.optimize` / `spatial.generate_preview` jobs take `input.spatialId` and retry without
  retraining. Workspaces are removed on success, failure, cancel and at startup.
- `src/ipfs/kuboClient.ts`: `addDirectoryStreamed`, `fileStat`, `listBundle`, `hasAllBlocksLocally`,
  `catToFile`, `catStream(..., innerFile)`.
- `src/gui/viewerCapabilities.ts`, `src/gui/spatialDelivery.ts`: short-lived read-only capability
  tokens and the Range/ETag/HEAD content route. **Not yet wired into `guiServer.ts`.**
- `src/utils/byteRange.ts`, analytics derivative counters, remote-compute bundle handling.
- `spatial-worker/`: typed errors, `splat_ply.py`, `derivatives.py`, new `server.py`
  (`kubus-spatial-worker/2`), `synthetic_splat.py` fixture generator, Dockerfile that builds
  `build-lod` and the SPZ binding at pinned versions.

## Verified facts

- Spark is vendored at 2.1.0 in the app and in the Node GUI. `build-lod` comes from
  `sparkjsdev/spark` commit `f22236f95fdd8078f0c12e3aab479523d401daf6` (tag v2.1.0).
  `--rad-chunked` writes `<in>-lod.rad` plus `<in>-lod-N.radc`. The header is a 4-byte `RAD0` magic,
  a u32 length and JSON with `chunks[].filename`. Chunks resolve with `new URL(filename, rootUrl)`.
  Load with `new SplatMesh({ url, paged: true })`.
- `build-lod` exits 0 on bad input; the worker checks its outputs instead.
- Spark 2.1.0 reads SPZ versions 1 to 3 only. Niantic `spz` v3.0.0
  (`5bf2945de1a003cee07133b1e495fe9c6ffdc7e7`) writes v4 by default, so `PackOptions.version = 3`.
- Measured on 200k synthetic splats: PLY 49.6 MB, SPZ preview 1.5 MB (100k splats),
  RAD 5.7 MB in 5 chunks.
- **Not verified:** that RAD, SPZ and PLY render in the same orientation in Spark. Render all three.
- Licence: the Spark repo LICENSE is MIT but `rust/Cargo.toml` says `license = "Proprietary"`.
  Unresolved; owner to decide whether to raise upstream.
- Docker Hub auth returns intermittent 504s. Build worker stages FROM the cached nerfstudio ghcr
  base rather than `rust:` / `python:` images.

## Defects found in the existing code

- `classFilterAllows` in `src/operator/commitments.ts` filters on `verificationClass`, not
  `storageClass`, so there is no real hot/warm/cold policy.
- `retention.deleteAfter` in capture payloads is parsed and never acted on.
- Node read worker errors from `body.error`; FastAPI sends `detail`. Fixed in `jobRuntime.ts`.
- `RuntimeManager.writeTopology` (and `KubusNodeSetup.ps1`) overwrite `runtime.env`.
- Setup runs `up -d kubo kubus-node-agent`, so the `spatial`-profile worker never starts; the release
  compose template has no GPU device reservation.

## Next steps, in order

1. Wire `guiServer.ts`: `POST /gui/api/spatial/:id/viewer-ticket`, `GET|HEAD /gui/content/<token>/<file>`
   before the `/gui/api` auth gate, job POST accepting `spatialId`/`derivatives`, one shared
   `ViewerCapabilities`, and a `redactSecrets` pattern for `/gui/content/<43 chars>`.
2. Tests: manifest, derivativeImport, spatialRecords, jobRuntime (success, derivative failure, resume,
   retry, cleanup), capabilities (expiry, wrong scene/variant, eviction), content route
   (Range/HEAD/ETag/304/416/traversal/log redaction), worker pytest, and a Kubo bundle integration test
   (`ipfs/kubo:v0.43.0`: add directory, pin, unpin another root plus `repo/gc` keeps shared blocks).
   Fix `derivatives.py` `toolVersion` to read `/opt/kubus/tools.json`.
3. Build the worker image; run an end-to-end with `synthetic_splat.py`; verify orientation in a browser.
4. Rewrite the viewer (`assets/spatial_viewer/src/viewer.js` in art.kubus is the source of truth; copy the
   bundle into `src/gui/public/vendor/spatialViewerBundle.ts`): preview first, then paged runtime, no Blob.
5. Pin policy on `storageClass` with capacity tiers; bundle roots pinned recursively. Source retention
   model (keep by default; opt-in sweeper).
6. Installer: GPU detection, `COMPOSE_PROFILES=spatial` or `--profile spatial`, merge `runtime.env`,
   GPU reservation in the release template, `KUBUS_SPATIAL_WORKER=auto|on|off`, truthful GUI state.
7. Backend PR: `normalizeBundle` in `spatialPublicationService.js` must accept `rootCid` + `entrypoint`;
   `verifyCidRetrievable` must check `<root>/<entrypoint>` for bundles.
8. art.kubus PR: Dart `SpatialVariant` bundle fields, bundle-aware `SpatialContentProxy`, Auto viewer,
   Spatial data surface, network policy, PRODUCT v5, EN/SL, tests.
9. Release a 0.8.2 prerelease per `docs/RELEASES.md`, then real RTX Node and S22 acceptance.

Merges are the owner's. Do not start Project D.
