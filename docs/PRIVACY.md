# Spatial privacy

## Local processing

The source capture stays on hardware controlled by the operator. The paired app transfers it to the local node, which stores it below the private data root and sends it only to the private worker. Neither raw frames nor unpublished results enter the network-managed public pin set.

## Network processing

The capture package is authenticated-encrypted before it enters IPFS. The selected provider receives the sealed data key, temporarily decrypts the source into an isolated working directory, and therefore can see plaintext during processing. The backend sees job metadata and encrypted CIDs but does not need the plaintext key. For maximum privacy, process locally.

The official provider runtime removes the plaintext job directory and unpins encrypted input after completion or failure. Filesystem, Kubo blockstore, crash dump, backup, malicious-provider and hardware-forensics retention are outside a cryptographic deletion guarantee. Operators should encrypt disks, exclude private job directories from backups, restrict administrators and monitor cleanup failures.

Unpublished result CIDs are unlisted, non-canonical and absent from the network-managed public pin set. Because the current alpha stores processed output in ordinary Kubo, they are not cryptographically private from a party who learns the CID. Only an authenticated artwork owner or authorised moderator can deliberately submit a result through canonical publication. Temporary encrypted input CIDs are registered as private compute roles and are rejected by public publication.

## Data-location guarantees

| Data | Filesystem | Kubo/IPFS | Backend/telemetry | Public registry and pin set |
| --- | --- | --- | --- | --- |
| Raw RGB/depth frames, camera poses and intrinsics | Private capture directory on the requester's node | Never added as plaintext | Never sent as capture content; only bounded job metadata is sent | Never |
| Network input | Packed only in requester memory before encryption | AES-256-GCM ciphertext only, temporary | CID, size, hashes and sealed key envelope; no plaintext key | Permanently ineligible |
| Provider plaintext | Isolated job directory while processing | Never added as plaintext | Never | Never |
| Unpublished processed variants | Worker/output directories until imported | Ordinary Kubo, pinned and unlisted | Private-output CID evidence for compute verification | Not canonical and not in the public pin set until authorised publication |
| Published spatial archive | Optional local caches | Canonical preview/mobile/archive variants | Canonical object/version metadata | Public, canonical and replicated |

Diagnostics and heartbeat metadata contain aggregate byte/count and health information only. They exclude raw frames, depth, camera poses, intrinsics, filenames, local capture paths, payload keys and decrypted provider content.
