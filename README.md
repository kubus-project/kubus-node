# kubus Node

### Local & distributed Gaussian splatting for a decentralised spatial archive.

Process spatial captures on your own GPU — or use an available GPU on the
Kubus network. Published spatial archives are distributed through
community-run nodes instead of depending on a single storage provider.

**Your GPU when you have one. The Kubus network when you don't.**

> kubus Node is a network participant, not a standalone Gaussian-splatting
> utility. The official runtime makes spatial-processing functionality
> available while the node is actively contributing storage and availability
> to the public art archive.

**Private compute in exchange for public infrastructure.** Operators receive local reconstruction, private local jobs, spatial-archive access and optional distributed GPU access. In return, every active official runtime must contribute backend-policy-compliant capacity to the canonical public archive.

```mermaid
flowchart TD
  C[Spatial capture] --> N[kubus Node]
  N -->|compatible local GPU| L[Local Gaussian reconstruction]
  N -->|network processing| P[Selected compute kubus Node]
  P --> G[Private Gaussian-splat result]
  L --> R[Review]
  G --> R
  R -->|explicit publish| A[Canonical spatial archive]
  A --> A1[Node A]
  A --> A2[Node B]
  A --> A3[Node C]
  A1 --> K1[Archive KUB8]
  P --> K2[Compute KUB8]
```

## In 30 seconds

kubus Node combines five boundaries in one source-available runtime:

- a Kubo/IPFS public archive participant with deterministic, byte-aware HOT/WARM/COLD replication;
- a paired `/local/v1` API for art.kubus without exposing operator credentials;
- an optional NVIDIA/CUDA Nerfstudio + gsplat worker for local Gaussian-splat reconstruction;
- an optional distributed-compute provider that receives encrypted temporary IPFS payloads under backend-issued leases;
- deliberate CID-first publication: private inputs and outputs are never canonical merely because a node reports them.

The art.kubus backend is the matchmaking and canonical trust boundary. It does not proxy large capture bytes and it is not a central Gaussian-processing server.

## Local Gaussian splatting

The local path is phone → paired node → private capture → local NVIDIA GPU → unpublished preview → user review → optional publication. Raw RGB, camera poses, intrinsics and depth remain below the node's private data root. Local/self jobs create no compute reward.

The worker uses the official Nerfstudio `1.1.5` image, `splatfacto`, and its compatible pinned `gsplat 1.4.0`. NVIDIA/CUDA is the only supported reconstruction target in this alpha. CPU reconstruction is not claimed or silently simulated.

## Distributed GPU compute

GPU sharing is opt-in. A requester discovers fresh, contributing, compatible nodes; chooses automatic ranking or a specific provider; encrypts the capture locally with AES-256-GCM; wraps the data key to the provider's X25519 key through HKDF; and adds only encrypted bytes to Kubo. The provider temporarily pins, decrypts and processes those bytes, returns content-addressed output, and removes its plaintext work directory.

The remote provider necessarily sees plaintext source data while running the job. Transport encryption protects the path and backend, not against the selected provider. For maximum privacy, process locally.

## Mandatory network participation

kubus Node is a network participant, not a standalone Gaussian-splatting utility. `NetworkParticipationGate` exposes `UNCONFIGURED`, `JOINING`, `CONTRIBUTING`, `DEGRADED`, and `LOCKED`. Spatial processing becomes available only after the node has verified its contribution to the public art archive: registration, backend policy, healthy Kubo, policy-minimum configured capacity, a synchronized non-empty canonical pin plan, successful reconciliation of every planned CID, an active scheduler, and an accepted current heartbeat must coincide. A heartbeat alone establishes liveness, not participation. `MAX_PINNED_BYTES=1`, production skip-pinning, `kubus-node gui`, and direct local API calls do not bypass the gate.

A short outage may enter `DEGRADED` only after successful participation was previously verified: running work is not killed, canonical public content remains readable, and diagnostics remain available. New work locks after the grace period. A fresh or never-verified node remains `JOINING`. See [participation](docs/PARTICIPATION.md).

## First install (Windows, no terminal)

Download and extract `kubus-node-windows-vX.Y.Z.zip`, then open
`Start-KubusNodeSetup.cmd`. It checks that Docker Desktop is running and has at
least 10 GiB free, pulls the immutable images recorded in
`docker-compose.release.yml`, starts the local stack, and opens
`http://127.0.0.1:8787/setup`. The setup page collects the scoped Node token,
creates a random GUI credential, writes a mode-0600 configuration beside the
durable Node identity, then restarts into the normal GUI. The LAN toggle
detects the PC's private address and recreates the runtime on `0.0.0.0`; when
off it remains loopback-only. Normal pairing never asks a user to type an IP
address. Stopping/uninstalling preserves Docker volumes by default; the
explicit volume-delete confirmation is the only destructive path.

Windows is archive-only in this release. Local NVIDIA reconstruction is only
supported on validated Linux Docker + NVIDIA/CUDA hosts; use remote processing
from Windows rather than claiming unsupported local GPU support.

## Operator CLI (npm)

`@kubus/kubus-node` is an optional cross-platform control and bootstrap CLI.
It is not a second Node implementation: production services always run from
the digest-pinned Kubernetes Node and spatial-worker container images in the
release manifest. The Windows ZIP remains the preferred normal-user Windows
installer.

Linux x64 and Windows x64 operators can install the exact release CLI with:

```sh
npm install -g @kubus/kubus-node
# or without a global install
npx @kubus/kubus-node setup
```

Docker Engine plus Compose v2 is required. `kubus-node setup` validates Docker,
pulls the immutable release images, starts only the loopback bootstrap service,
and opens the same setup wizard as the Windows installer. No checkout, source
build, manual `.env`, or `docker compose --build` is used. `setup --headless`
starts that loopback wizard without opening a browser, for access through an
SSH tunnel on a server. `kubus-node doctor --json` is safe for automation.

Use `kubus-node update` only after deliberately selecting the desired released
CLI version (for example `npx @kubus/kubus-node@beta update`); it applies that
package's verified immutable runtime manifest and preserves Docker volumes.
`npm uninstall -g @kubus/kubus-node` removes only the CLI. It never removes the
Node runtime, identity, pairings, Kubo archive, or captures. Use
`kubus-node uninstall` to stop the runtime while preserving data, or add both
`--delete-data --yes-delete-data` for the explicitly destructive path.

NPM channels track runtime channels: alpha uses `edge`, beta uses `beta`, and
stable uses `latest`. macOS is intentionally unsupported for this alpha CLI.

## Quick start (operators)

```sh
cp .env.example .env
docker compose up --build
```

Set a scoped operator token, operator identity, node label, reachable endpoint and strong local GUI token. The backend policy currently controls the minimum committed public-archive capacity; the example allocates 50 GiB.

Spatial-capable NVIDIA/CUDA host:

```sh
docker compose --profile spatial up --build
```

Kubo RPC and worker HTTP remain private to the Compose network. The Kubo gateway and node UI are loopback-bound by default.

## Hardware

- Archive-only: any current x86-64/ARM64 Docker host with enough disk for the configured contribution.
- Reconstruction/provider: Linux Docker host, NVIDIA GPU and driver compatible with the pinned Nerfstudio CUDA image, plus adequate VRAM for the requested tier.
- Remote-provider mode: explicitly set `OFFER_REMOTE_COMPUTE=true`; use concurrency, queue, input-size and free-VRAM limits from `.env.example`.

## Capture privacy and publication

Private captures and encrypted temporary inputs never enter the public object registry or public pin set. Processed output added to the node's ordinary Kubo is **unpublished and unlisted, not cryptographically private**: it is not canonical or replicated by archive policy, but a party who learns its CID may be able to retrieve it. Publication requires an authenticated artwork owner (or authorised moderator), valid CID/size/MIME roles, retrievability where policy requires it, and backend canonicalisation. Supported spatial roles are `spatial_preview` (HOT), `spatial_mobile` (WARM), and `spatial_archive` (COLD), grouped under one object/version bundle.

CID identity is canonical. Retrieval is local Kubo first, then IPFS/provider discovery and Kubus peers, then configured HTTP gateways with CID verification; legacy backend files are a final compatibility fallback where still required. No architecture depends on `ipfs.io`.

## Two KUB8 contribution rails

Archive availability uses the historical `public-archive-stewardship-1` records unchanged and current `public-archive-stewardship-2` bundle-aware scoring. Verified canonical bytes, retrieval, reliability, policy classes, capped logarithmic weighting and diminishing returns drive an independent archive pool.

Distributed compute uses backend-issued leases, distinct requester/provider operators, signed provider receipts, a separately signed requester acknowledgement, retrievable output, `spatial-compute-units-1`, fraud caps and a separate compute pool. Raw GPU seconds, owning hardware, local jobs, failed/expired/cancelled work and duplicate receipts earn zero.

Both are pending control-plane records. Settlement is not active; KUB8 has no guaranteed payout or market return.

## Architecture and APIs

- [Architecture](docs/architecture.md)
- [Local API](docs/LOCAL_API.md)
- [Spatial processing](docs/SPATIAL.md)
- [Participation gate](docs/PARTICIPATION.md)
- [Distributed compute](docs/DISTRIBUTED_COMPUTE.md)
- [Rewards](docs/REWARDS.md)
- [Privacy](docs/PRIVACY.md)
- [Remote paired-device transport](docs/REMOTE_TRANSPORT.md)
- [Security](docs/security.md)
- [Operator guide](docs/operator-guide.md)
- [Release channels](docs/RELEASES.md)

## Current limitations

- Alpha transport uses encrypted temporary IPFS payloads; direct QUIC/libp2p job transfer is not yet the preferred implementation.
- A selected compute provider sees plaintext while processing. Secure hardware/provider-proof privacy is not claimed.
- Reconstruction currently exports the archival PLY variant. Additional preview/mobile optimisation remains renderer-version dependent.
- Browser clients do not call insecure LAN nodes from HTTPS; Flutter Web uses browser-safe public resolution.
- KUB8 settlement is pending-record-only. The alpha abuse controls are not claimed to be Sybil-proof.

## Releases and source status

Channels are `alpha → edge`, `beta → beta`, and stable → `latest`; an alpha image never updates `latest`. Exact SemVer tags and image tags are immutable.

This repository is source available and publicly inspectable, but it remains `UNLICENSED`. No MIT, Apache, GPL or other open-source grant applies to kubus Node itself. Nerfstudio and gsplat retain their Apache-2.0 licenses; other third-party notices are documented separately.
