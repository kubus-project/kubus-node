# Architecture

Kubus Availability has two sides:

- Backend control plane: canonical public-object registry, node records, commitments, heartbeats, verification checks, scores, epochs, and pending KUB8 reward records.
- Node runtime: Kubo peer discovery, canonical CID pinning, local retrieval checks, commitment submission, liveness heartbeat, and status reporting.

The public-object registry is the source of truth for rewardable CIDs. The node fetches `/api/availability/rewardable-cids` and never invents rewardable content.

Commitments declare that a registered node intends to keep a canonical CID available until `expiresAt`. Heartbeats are diagnostics and liveness only; they are not proof of availability. Backend verification checks the committed endpoint and calculates scores. Rewards are stored as pending control-plane records, not settled payouts.
