# Releases

kubus Node uses SemVer. Exact Git and container tags are immutable.

| Version | Container channel | Intended use |
|---|---|---|
| `*-alpha.*` | `edge` | Integration testing; breaking protocol changes remain possible |
| `*-beta.*` | `beta` | Broader operator testing with a stabilizing protocol |
| Stable SemVer | `latest` | Supported production channel |

An alpha or beta never updates `latest`. Every `v*` tag runs type checking, tests, the TypeScript build, dependency audit, node and worker image builds, release-bundle checksums, and SPDX SBOM generation before GitHub release assets are published. A failed workflow is a failed release, regardless of whether the Git tag exists.

The compose bundle contains no credentials. Operators must create `.env` from the included example and supply their own scoped token and local secrets.

## v0.8.0-alpha.4 — Spatial Network Integration

This alpha completes the integrity and product pass for real spatial-network testing:

- **Participation integrity:** a fresh node must successfully reconcile the public archive, meet the active policy, and receive an accepted heartbeat before spatial processing is enabled. A heartbeat alone never establishes participation. Grace access is available only to a previously verified contributor.
- **Distributed compute:** remote completion uses signed provider output receipts and signed requester acknowledgements, with exact job, input, specification, output CID, timestamp, and protocol binding. The backend also verifies output retrievability before compute contribution can be recorded.
- **Spatial archive:** the art.kubus app exposes canonical spatial captures through an artwork viewer, an archival history, and subtle map discovery indicators.
- **Privacy:** raw captures stay in local private storage by default; remote input is encrypted in transit and at rest in IPFS, while the selected provider temporarily sees plaintext during processing. Unpublished processed output in ordinary Kubo is unlisted and non-canonical, but is not cryptographically private from someone who knows its CID. Published variants are public, canonical, and replicated.
- **Operator and app UX:** joining, degraded grace, pairing, provider choice, processing stages, result review, explicit publication, and separate archive/compute contribution surfaces use consistent English and Slovenian copy.
