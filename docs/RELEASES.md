# Releases

kubus Node uses SemVer. Exact Git and container tags are immutable.

| Version | Container channel | Intended use |
|---|---|---|
| `*-alpha.*` | `edge` | Integration testing; breaking protocol changes remain possible |
| `*-beta.*` | `beta` | Broader operator testing with a stabilizing protocol |
| Stable SemVer | `latest` | Supported production channel |

An alpha or beta never updates `latest`. Every `v*` tag runs type checking, tests, the TypeScript build, dependency audit, node and worker image builds, release-bundle checksums, and SPDX SBOM generation before GitHub release assets are published. A failed workflow is a failed release, regardless of whether the Git tag exists.

## Canonical runtime and npm channel

One release creates the immutable Node image, immutable spatial-worker image,
release Compose file, Windows ZIP, operator archive, release manifest, and the
`@kubus/kubus-node` npm tarball. The release manifest records the source SHA,
channel, exact image digests, Compose checksum, minimum CLI version, and
protocol version. Both the Windows installer and the npm CLI use that release
Compose definition; neither builds or executes a checkout.

NPM publication happens only after the release assets have been generated from
the exact tested tarball. It uses GitHub Actions OIDC provenance and maps
`alpha` to `edge`, `beta` to `beta`, and stable to `latest`. If a publication
step is retried after the GitHub Release exists, it reuses the same tarball and
must retain the same version, manifest checksum, and image digests; a changed
artifact is a release failure, not a retry.

The npm CLI is a passive installer/control package. It has no package lifecycle
hooks. `npm uninstall -g @kubus/kubus-node` removes only the CLI; Docker
volumes and the durable Node identity remain until the operator explicitly runs
the destructive `kubus-node uninstall --delete-data --yes-delete-data` path.

The compose bundle contains no credentials. Operators must create `.env` from the included example and supply their own scoped token and local secrets.

## v0.8.0-alpha.4 — Spatial Network Integration

This alpha completes the integrity and product pass for real spatial-network testing:

- **Participation integrity:** a fresh node must successfully reconcile the public archive, meet the active policy, and receive an accepted heartbeat before spatial processing is enabled. A heartbeat alone never establishes participation. Grace access is available only to a previously verified contributor.
- **Distributed compute:** remote completion uses signed provider output receipts and signed requester acknowledgements, with exact job, input, specification, output CID, timestamp, and protocol binding. The backend also verifies output retrievability before compute contribution can be recorded.
- **Spatial archive:** the art.kubus app exposes canonical spatial captures through an artwork viewer, an archival history, and subtle map discovery indicators.
- **Privacy:** raw captures stay in local private storage by default; remote input is encrypted in transit and at rest in IPFS, while the selected provider temporarily sees plaintext during processing. Unpublished processed output in ordinary Kubo is unlisted and non-canonical, but is not cryptographically private from someone who knows its CID. Published variants are public, canonical, and replicated.
- **Operator and app UX:** joining, degraded grace, pairing, provider choice, processing stages, result review, explicit publication, and separate archive/compute contribution surfaces use consistent English and Slovenian copy.
