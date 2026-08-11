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

## Output and verification

The provider signs a receipt binding job, input hash, job-spec hash, output CIDs, worker/protocol version and completion time. The requester retrieves the manifest and variants by CID, checks membership/retrievability, previews the private result, then signs acceptance or rejection. Publication is a separate authenticated CID-first request through the canonical spatial-publication service.

Rewards require a completed verified job and use `spatial-compute-units-1`; see [REWARDS.md](REWARDS.md). Direct libp2p/QUIC negotiation is not yet an attributable compute transport. Encrypted temporary IPFS payloads are the implemented alpha data plane.

