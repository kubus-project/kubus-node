# Architecture

The backend determines what is canonical. Kubus Nodes store, process, retrieve, and serve the public archive. Flutter is the spatial interface.

## Runtime boundaries

- **Backend control plane:** identity and authorization, ownership, canonical manifests and signed records, public-object registry, network policy, verification, scoring, and pending KUB8 accounting.
- **Kubus Node:** persistent identity, Kubo/IPFS, local authentication, private captures, generic jobs, capability health, byte-aware public replication, publication handoff, availability contribution, and safe telemetry.
- **Optional spatial worker:** reconstruction, Gaussian training/export, optimization/conversion and preview production behind a private service boundary. It never owns auth, publication, Kubo, or node identity.
- **art.kubus app:** ARCore/ARKit tracking, capture guidance, paired-node transfer, job/status UI, orbit spatial viewing, and public/network fallbacks.

`CapabilityRegistry` is the source of truth for runtime capability and health. A lightweight node exposes archive and local-gateway capabilities while spatial/GPU capability remains unavailable. Registration and heartbeat metadata advertise this without requiring old nodes to send the new fields.

`JobRuntime` persists job state in the atomic local store, bounds concurrency, recovers interrupted running jobs to queued state, supports cancellation, validates private paths, and imports approved worker outputs into Kubo. GPU jobs never hold `ActionLock`; availability scheduling remains independent.

Public replica state and private local state are separate. Only backend-issued public pin-set records enter byte-aware planning. A processed output stays local until authenticated publication creates a canonical object version.

## Retrieval order

1. Local Kubo `pin/add` and native IPFS provider/Bitswap resolution.
2. Configured Kubus-compatible network paths.
3. Public HTTP gateways.
4. Legacy backend retrieval when needed.

HTTP fallback bytes are imported through Kubo and accepted only when the resulting CID matches the requested CID.

## Verification boundary

The node advertises its Kubus node ID, persistent node key identity, and Kubo peer ID. HTTP verification remains implemented. The verifier abstraction records `http` or `ipfs_peer` mode, but attributable libp2p peer verification is not complete; peer-only checks fail with `IPFS_PEER_VERIFIER_UNAVAILABLE` and never become fabricated proof.
