# Spatial delivery: status and what other repositories must do

Status of the pipeline on `feat/spatial-delivery-pipeline` (kubus-node PR 25). Evidence classes are kept apart:
UNIT, CONTAINER, BROWSER (Chromium with SwiftShader, no GPU), REAL GPU, PHYSICAL ANDROID, INDEPENDENT NETWORK OPERATOR.
**No REAL GPU, PHYSICAL ANDROID or INDEPENDENT NETWORK OPERATOR evidence exists.** `ns-train` / `ns-export`
(reconstruction itself) has never run on a GPU in this work.

```
capture -> GPU reconstruction -> master PLY (archive, cold)
                              -> preview SPZ v3 (hot)        spz v3.0.0   5bf2945d...
                              -> runtime RAD bundle (warm)   build-lod    f22236f9... (Spark 2.1.0)
        -> kubus.spatial/1 manifest -> viewer ticket -> capability content route -> progressive viewer
```

## Done here (this repository)

- Derivatives share the master's coordinate frame (fixed a 180 degree rotation about X in the preview); the worker
  reads the SPZ header back and rejects an empty or wrong-version container (the real binding writes one on a
  missing field instead of raising).
- Viewer ticket + capability content route wired into the GUI server; the bootstrap uses them (no Blob, no archive
  default, revokes on page hide). `scripts/previewSpatialViewer.ts` serves real worker output through it.
- Embedded viewer is generated from art.kubus by `scripts/sync_spatial_viewer_bundle.mjs` (`--check` verifies equality
  and that the app bundle reproduces from its source).
- Pin policy by storage class; capture retention sweeper (off by default); installer GPU worker enablement and
  `runtime.env` merge. See `docs/operator-guide.md`.

## Other repositories

**Backend** (branch `claude/happy-bohr-o4lwe6`, based on master): bundle variants in `spatialPublicationService.js` /
`publicPublicationService.js` (done; see `docs/SPATIAL_COMPUTE.md` there). Not done: authorization still uses wallet
equality; switching to `artworkAccess.canEditArtwork` depends on the wallet-optional PR that introduces that module.
Whether `ownerWalletAddress` may be null for wallet-less artists is unverified. Rewarding bundle replication needs a
verifier that can prove ranged retrieval of a bundle member; none exists.

**art.kubus** (branch `claude/happy-bohr-o4lwe6`, based on dev): only `assets/spatial_viewer` changed (additive
`loadSpatialProgressive`, `unloadSpatial`, `spatialViewerState`; `loadSpatial` unchanged). Not done, Dart side:
`SpatialVariant` bundle fields (`rootCid`, `entrypoint`, `fileCount`), a bundle-aware `SpatialContentProxy`
(ranged reads inside a bundle), an Auto viewer that calls `loadSpatialProgressive`, network policy, EN/SL strings,
PRODUCT v5 styling, tests. Held back deliberately: dev moved under the wallet branches.

## Still required before this is accepted

1. Real RTX run of reconstruction + derivatives + the rebuilt worker image (Docker was unavailable here).
2. Physical Galaxy S22 viewing of preview then runtime.
3. An independent operator Node pulling a bundle through the pin policy.
4. Windows PowerShell 5.1 and Docker Desktop installer runs (the PowerShell logic is tested under PowerShell 7 only here).
5. Browser coverage of the GUI scene-detail buttons (create/open original); the page script parses but those handlers have no test.

## Blocker

Spark's repository LICENSE is MIT but `rust/Cargo.toml` for `build-lod` says `license = "Proprietary"`. Unresolved;
the owner decides whether to raise it upstream before `build-lod` ships in a release image.
