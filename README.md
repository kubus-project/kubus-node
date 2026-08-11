# Kubus Node — local runtime and public archive node for art.kubus

Kubus Node runs part of the art.kubus network on hardware you control. It keeps canonical public cultural records available through Kubo/IPFS, provides a securely paired local API for art.kubus apps, and can optionally process private spatial captures on a supported NVIDIA workstation.

The backend remains the canonical control plane. Nodes store, process, retrieve, and serve bytes; they cannot make arbitrary CIDs canonical or rewardable. Raw captures, source frames, unapproved outputs, credentials, messages, drafts, wallet backups, and admin data never enter the public pin set.

## What it does

- Preserves the existing availability network: identity, registration, public pin-set sync, commitments, heartbeats, verification metadata, contribution scoring, and pending KUB8 records.
- Detects explicit `archive`, `localContentGateway`, `spatial.reconstruction`, `spatial.optimization`, `spatial.gaussianSplat`, and `compute.gpu` capabilities.
- Exposes versioned `/local/v1` status, content, pairing, capture, job, spatial, and publication-handoff APIs.
- Retrieves canonical CIDs through local Kubo/IPFS first and uses HTTP gateways only as fallback, verifying a fallback import resolves to the requested CID.
- Plans network-managed public replicas by byte budget and storage class while keeping private/operator-owned content separate.
- Runs bounded persistent spatial jobs without holding the availability scheduler's action lock.

See [architecture](docs/architecture.md), [local API](docs/LOCAL_API.md), [spatial processing](docs/SPATIAL.md), [rewards](docs/REWARDS.md), and [security](docs/security.md).

## Quick start

1. Install Docker with Compose.
2. Copy `.env.example` to `.env` and set `KUBUS_API_BASE_URL`, the scoped `KUBUS_OPERATOR_TOKEN`, operator identity, and a strong `NODE_GUI_TOKEN`.
3. Start the lightweight archive node:

```sh
docker compose up --build
```

This starts `kubus-node-agent` and `kubo`. Kubo RPC remains private; host ports are loopback-bound by default. The archive runtime continues operating if no spatial worker exists.

For local development without Compose:

```sh
npm install
npm run build
npm test
npm run start
```

## Optional spatial profile

On a supported NVIDIA/CUDA host:

```sh
docker compose --profile spatial up --build
```

The profile adds `kubus-spatial-worker` on a private Compose network. It is based on the official Nerfstudio `1.1.5` image and pins `gsplat 1.5.3`; it reports unsupported hardware rather than pretending CPU reconstruction is available. The Node.js agent remains lightweight and owns auth, paths, jobs, Kubo import, manifests, and publication handoff.

## Local API and device pairing

The administrative GUI remains localhost-only by default. LAN API exposure is separately controlled with `LOCAL_API_ENABLED`, `LOCAL_API_ALLOW_LAN`, `LOCAL_API_HOST`, and `LOCAL_API_PORT`. Create pairing sessions from loopback or an authenticated GUI request, then scan/paste the one-time payload in art.kubus.

Pairing exchanges a short-lived, one-use secret for a hashed-at-rest `kubus_local_...` credential scoped to content, captures, jobs, spatial reads, and publication requests. It never exposes the operator token, node key, wallet key, or settlement credentials. Browser origins are rejected; Flutter Web stays on HTTPS public/network resolution.

## Archive network and storage policy

The node consumes the backend's canonical public pin set. Pin order is deterministic: hot manifests, signed public records, previews and metadata first; warm mobile spatial/media next; cold archival spatial variants last. `MAX_PINNED_BYTES` is the primary capacity budget and `MAX_PINNED_CIDS` remains a secondary guard.

Raw captures are stored below the private local data root with restrictive permissions. They are deletable when no active job uses them and are never automatically published, replicated, or rewarded.

## KUB8 contribution

Verified hosting of canonical public content can contribute under the backend availability policy. Merely running software, creating a capture, or reconstructing a spatial record earns nothing. Spatial processing itself has no KUB8 reward. Settlement is not active; the backend records pending proportional epoch allocations.

## Status and limitations

- HTTP node verification remains available for publicly reachable nodes. Kubo peer identity is advertised, but attributable libp2p peer verification is not yet implemented; the backend fails that mode explicitly instead of treating ordinary gateway retrieval as node proof.
- `spatial.reconstruct` is implemented by the optional worker. Optimization and preview job types are versioned and persistent but currently fail explicitly as unsupported until their worker implementations ship.
- AR camera-aligned splat rendering is intentionally not faked. The app's bundled Spark viewer is an orbit viewer; tracked AR remains in ARCore/ARKit.
- This repository currently carries an `UNLICENSED` pre-launch license. Its source can be inspected, but no open-source license is granted yet.
