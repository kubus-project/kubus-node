# Distributed compute protocol

Protocol: `kubus.compute/1`. Job specification: `kubus.spatial-job/1`.

## Discovery and matching

The backend derives candidates from the existing node registration and fresh heartbeat records. A candidate must be registered, active, `CONTRIBUTING`, lease-eligible, worker-healthy, explicitly offering remote work, unpaused, within queue/concurrency limits, compatible with the job/protocol/worker, large enough for the encrypted input and required VRAM, and advertising X25519 encryption plus Ed25519 signing public keys. Ranking combines compatibility, queue, reliability, successful retrieval and recent failures; GPU model alone never decides ranking. Only a node label and safe compute metrics are returned—never tokens, private addresses, secrets or provider wallet addresses.

## Lifecycle

```text
REQUESTED -> MATCHED -> ACCEPTED -> INPUT_READY -> RUNNING
          -> OUTPUT_READY -> VERIFYING -> VERIFIED -> COMPLETED
```

Legal terminal paths are `DECLINED`, `EXPIRED`, `FAILED`, `CANCELLED`, and `DISPUTED`. The backend enforces transitions and actor authorization. Provider acceptance is explicit. The lease binds job/requester/provider, canonical spec and hash, input CID/hash, expiry and protocol. Expired leases cannot create rewards.

## Private data plane

The requester creates a stable capture package, compresses it, encrypts it with a random AES-256-GCM data key, and adds only ciphertext to Kubo. X25519 shared secret plus HKDF-SHA-256 derives an AES-256-GCM wrapping key for the selected provider. The backend relays the CID and sealed key envelope; it does not receive the raw key or plaintext bytes.

The provider pins the temporary CID, verifies the ciphertext hash and authenticated-encryption tags, validates every extracted relative path and size bound, decrypts into a job-specific private directory, and invokes its private worker using a short-lived HMAC token bound to job ID and job type. The worker has no public Compose port and rejects missing, expired or mismatched authorization. Plaintext is recursively removed and the temporary CID unpinned after completion or failure.

The remote provider necessarily sees plaintext source data while processing. Encryption protects transport and intermediaries, not against the selected provider.

**Photo and video captures are never sent to a provider.** Masking happens inside the local worker job, never on the stored files, so a `photos`, `video` or `mixed` capture still holds the unmasked source of whoever stood in front of the camera. `POST /local/v1/compute/jobs` refuses such a capture with `422 remote_compute_media_capture_unsupported` before anything is read or encrypted (the packing code refuses any file under `photos/` or `video/` as well). Only posed-frame captures can be offered to a remote provider until the Node masks before it packs; run photo and video captures on this Node's own worker.

## Output and verification

The provider signs a receipt binding job, input hash, job-spec hash, output CIDs, worker/protocol version and completion time. The requester retrieves the manifest and variants by CID, checks membership/retrievability, previews the unpublished result, then signs acceptance or rejection. The backend verifies both signatures against the identities captured for the assignment and checks the exact job, hashes, output CID set, decision, timestamps and protocol version. Publication is a separate authenticated CID-first request through the canonical spatial-publication service.

Rewards require a completed verified job and use `spatial-compute-units-1`; see [REWARDS.md](REWARDS.md). Direct libp2p/QUIC negotiation is not yet an attributable compute transport. Encrypted temporary IPFS payloads are the implemented alpha data plane.

## Encrypted result transport

An explicitly negotiated `kubus.private-output/1` job records the requester's X25519 public key at assignment. The provider encrypts each worker variant and the spatial manifest before writing to Kubo. The signed output receipt binds ciphertext references and digests, plaintext lengths and digests, and the recipient key envelopes to the job and job-spec hash. The requester re-verifies the signature, file sizes, and digests before making the result available in its private local staging directory. An accepted acknowledgement signs the exact output commitment. The default result transport remains compatible with existing jobs.

This transport can be tested independently of browser source dispatch.

## Full and lightweight output (`kubus.spatial-output/2`)

A provider's worker turns the trained splat into two files and never ships the raw training PLY, which stays in the provider's work directory and is deleted with it. `spatial_mobile` is the full render derivative: the same splats in the same order with the same float32 values, every spherical-harmonic coefficient kept, and only the all-zero `nx ny nz` normals dropped, so a render is pixel-identical. When that file is larger than the budget (default 20 MiB, `KUBUS_SPATIAL_LIGHTWEIGHT_MAX_BYTES`, clamped to 1 to 20 MiB) the worker also writes `spatial_preview`: `x y z f_dc_0..2 opacity scale_0..2 rot_0..3` as float32 (degree 0, 56 bytes per splat), keeping the most important splats (sigmoid of opacity times the exponential of the two largest scales, ties by original index) that fit the budget, in their original order. The manifest records `processing.lightweight` (`method`, `sourceSplats`, `keptSplats`, `shDegree`, `budgetBytes`), or `null` when the full file is its own preview. A PLY the worker cannot read fails the job with `output_conversion_failed`.

The worker's `/health` reports `outputProtocol: "kubus.spatial-output/2"`; the provider Node sends it in its heartbeat as `compute.remote.spatialOutputProtocol` only when the worker reports it. The requester matches only providers that advertise it, and rejects a result that holds `spatial_archive` without `spatial_mobile` as `provider_output_outdated`. The candidate is declared to the backend with both files (the lightweight only when the full file is over the 20 MiB the backend allows a companion for) and each is uploaded from the server's own `receivedBytes`. A `COMPLETED` job is imported only when this requester's own accepted acknowledgement of the staged output is on it.

## Provider cleanup attestation

When a job is terminal (for `COMPLETED`, after the requester's acknowledgement), the provider Node has run its local cleanup and released the sealed outputs. Sealed outputs are never released before that. It then builds a `kubus.provider-cleanup/1` statement from its own journals: job, provider, input hash and final state; when it received the job and when the worker started and finished; `decryptedInput`, `workDirectory`, `plaintextOutputs` and `sealedOutputs` each `deleted`, `not_present` or `failed`; `outputPins` `released`, `not_present` or `failed`; and `state: complete` only if nothing failed. It signs it with its compute signing key over `kubus.provider-cleanup/1` + newline + the canonical payload (the prefix keeps it from ever standing for a job receipt), keeps it in the local state, and posts it to `POST /api/compute/provider/jobs/:jobId/cleanup` with backoff until the backend accepts it, across restarts. A `failed` statement is replaced by a later `complete` once the cleanup succeeds. Releasing sealed outputs needs `KUBUS_MANAGED_PIN_RELEASE_ENABLED=true`; while it is off the statement honestly says `sealedOutputs` and `outputPins` failed.

The requester verifies the statement on the job view against the provider's pinned signing key (schema, job, provider, input hash, terminal state, signature), records it in its attempt state, and looks again for one that has not arrived yet.

Trust boundary: the attestation is an authenticated statement by the provider, bound to one job. It is not cryptographic proof of physical erasure; a provider that wanted to keep data could sign `deleted` all the same. It shows that an honest provider finished and that a provider which did not say so can be seen.

## Managed requester (browser pilot)

The Kubus-operated requester Node runs with `KUBUS_MANAGED_REQUESTER=true` and is the node the backend names in `SPATIAL_PILOT_REQUESTER_NODE_ID`. It polls `/api/spatial/reconstruction-bridge` with its own operator token. The backend binds each claimed attempt to the walletless artist, the artwork and an immutable source revision. The requester sees only file ids, formats, sizes and SHA-256 digests.

For each attempt it:

1. Downloads every source file in chunks and verifies its size and digest. A resumed attempt keeps files already verified.
2. Prepares the set on its own worker in the `source_set` input mode: photos and any number of clips, faces always masked, COLMAP poses, stopping before training. Typed failures such as `sfm_failed` or `frames_too_blurry` go back to the artist with per-file usable-view counts.
3. Packs only `capture.json` and the masked dataset as a `prepared` capture. That kind holds no file under `photos/` or `video/`, so the media-capture refusal above still holds for raw media.
4. Matches a provider that advertises `kubus.private-output/1` and `kubus.spatial-output/2`, encrypts the capture to that provider, and has the backend create the job. The canonical spec carries the attempt's source binding.
5. Follows the job. A verified, staged result is acknowledged and uploaded as the artist's new private candidate (the full file, and the lightweight one when there is one; see below). A result that fails verification is disputed, and so is a legacy result (`provider_output_outdated`). A failed, expired or disputed job releases the encrypted input and excludes that provider. After three providers the attempt fails as `no_provider_completed`.
6. When the artist cancels, cancels the provider job, releases the input and confirms.
7. On every way an attempt can end (ready, failed, needs more views, cancelled) releases what it holds and reports its own cleanup (`cleanup { state }`). On `ready` that happens only after the backend says both artifacts arrived.

Work files go when an attempt ends. Verified source copies stay until the backend's retention list names the attempt: seven days after the last attempt, or when the artist deletes the sources. A provider trains a `prepared` capture in the worker's `prepared` input mode. Providers therefore need a worker image that advertises `prepared` in `inputModes`; one without it fails the job, and the requester moves to the next provider.
