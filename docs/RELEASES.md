# Releases

kubus Node uses SemVer. Exact Git and container tags are immutable.

| Version | Container channel | Intended use |
|---|---|---|
| `*-alpha.*` | `edge` | Integration testing; breaking protocol changes remain possible |
| `*-beta.*` | `beta` | Broader operator testing with a stabilizing protocol |
| Stable SemVer | `latest` | Supported production channel |

An alpha or beta never updates `latest`. Every `v*` tag runs type checking, tests, the TypeScript build, dependency audit, node and worker image builds, release-bundle checksums, and SPDX SBOM generation before GitHub release assets are published. A failed workflow is a failed release, regardless of whether the Git tag exists.

The compose bundle contains no credentials. Operators must create `.env` from the included example and supply their own scoped token and local secrets.

