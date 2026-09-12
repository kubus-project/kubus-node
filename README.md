# kubus Node

[![CI](https://img.shields.io/github/actions/workflow/status/kubus-project/kubus-node/pr-validation.yml?branch=master&label=CI)](https://github.com/kubus-project/kubus-node/actions/workflows/pr-validation.yml)
[![Current release including prereleases](https://img.shields.io/github/v/release/kubus-project/kubus-node?include_prereleases&label=release)](https://github.com/kubus-project/kubus-node/releases)
[![npm edge publication pending](https://img.shields.io/badge/npm-edge%20pending-777777)](#release-channels)
[![Docker runtime](https://img.shields.io/badge/runtime-Docker-777777)](docs/RELEASES.md)
[![Source available](https://img.shields.io/badge/source-available-777777)](#source-status)

Local runtime and public archive Node for art.kubus.

Keep the public art archive available. Process Spatial captures on your own
hardware. Connect securely from art.kubus.

[Download for Windows](https://node.kubus.site/download/windows) ·
[Install](https://node.kubus.site/install) ·
[Documentation](https://node.kubus.site/docs) ·
[node.kubus.site](https://node.kubus.site)

## Install

### Windows

[Download kubus Node for Windows x64](https://node.kubus.site/download/windows).
Have Docker Desktop running with its WSL 2 backend, install kubus Node, and open
setup. Sign in to art.kubus, review the permissions, and authorize the Node.
It then appears in My Nodes. Normal setup does not require a manual operator token.

### npm

The alpha channel is `edge`. These are the channel commands:

```sh
npm install -g @kubus/kubus-node@edge
kubus-node setup
```

Or, without a global install:

```sh
npx @kubus/kubus-node@edge setup
```

**Publication status, verified 2026-09-11:** alpha.5's public npm publication
failed after its tested GitHub assets were published. The public registry
currently returns 404. Until this is repaired, install the exact official
release tarball instead:

```sh
npm install -g https://github.com/kubus-project/kubus-node/releases/download/v0.8.0-alpha.5/kubus-kubus-node-0.8.0-alpha.5.tgz
kubus-node setup
```

Use `kubus-node doctor --json` for diagnostics. Both installers start the
release's digest-pinned Docker runtime; they do not build a checkout.

## What it does

- Stores and serves canonical public cultural records in the distributed archive.
- Runs local Gaussian reconstruction on compatible NVIDIA/CUDA hardware, or requests processing from a selected network provider.
- Connects owned Nodes to art.kubus using the supported WebRTC/TURN transport.

The official runtime requires archive participation. Sharing a GPU as a remote
compute provider is optional. [Runtime guide](docs/node-runtime-guide.md).

## Privacy

**PROCESS ≠ PUBLISH. SYNC ≠ PUBLISH.**

Local processing keeps raw capture processing on your Node. A selected remote
provider necessarily sees plaintext while processing; transport encryption does
not make that provider blind. Output in ordinary Kubo is unlisted and
non-canonical until publication, but someone who knows its CID may be able to
retrieve it. Explicit authorized publication creates canonical public state.
[Privacy details](docs/PRIVACY.md).

## Requirements

- Windows x64 or Linux x64; Docker Engine with Compose v2. The npm CLI needs Node.js >=20.19 and npm >=10. macOS is unsupported by this alpha CLI.
- No GPU is needed for archive participation. Windows can request remote processing; local Windows GPU reconstruction is not validated in this release.
- Local reconstruction/provider: validated Linux Docker host, NVIDIA/CUDA, NVIDIA Container Toolkit and sufficient VRAM. CPU reconstruction is unsupported.
- Archive capacity is controlled by backend policy. The source example allocates 50 GiB; the Windows launcher checks at least 10 GiB free. Allow additional space for runtime images, captures and output.

## Architecture

[Architecture](docs/architecture.md) · [Local API](docs/LOCAL_API.md) ·
[Spatial](docs/SPATIAL.md) · [Remote transport](docs/REMOTE_TRANSPORT.md) ·
[Distributed compute](docs/DISTRIBUTED_COMPUTE.md) ·
[Participation](docs/PARTICIPATION.md) · [Security](docs/security.md)

The backend is the matchmaking and canonical trust boundary, not a central
capture-processing server. Archive contribution, compute-provider compensation
and public Spatial contribution are separate records. KUB8 settlement remains
pending; there is no guaranteed payout or market return. [Contribution details](docs/REWARDS.md).

## Development

Installing a released Node does not require source development. For a checkout:

```sh
git clone https://github.com/kubus-project/kubus-node.git
cd kubus-node
npm ci
npm run typecheck
npm test
```

Configure `.env` from `.env.example` using the [operator guide](docs/operator-guide.md), then:

```sh
docker compose up --build
# Compatible NVIDIA/CUDA development host:
docker compose --profile spatial up --build
```

## Release channels

| Release | npm / image alias |
| --- | --- |
| Alpha | `edge` |
| Beta | `beta` |
| Stable | `latest` |

Floating image tags are discovery aliases. Reproducible operation uses the
manifest's image digests and `docker-compose.release.yml` in the official
[release ZIP](https://node.kubus.site/download/zip). Verify the
[checksums](https://node.kubus.site/download/checksums) and inspect the
[manifest](https://node.kubus.site/download/manifest). GitHub Actions artifacts
are not public distribution endpoints. [Release contract](docs/RELEASES.md).

## Source status

kubus Node is **source available** and **UNLICENSED**. No open-source licence
grant applies to kubus Node itself. Third-party components retain their own
licences. Protocol and implementation detail previously in this README remains
in the [runtime guide](docs/node-runtime-guide.md) and the linked documentation.
