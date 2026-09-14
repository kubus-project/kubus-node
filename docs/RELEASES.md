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

## v0.8.0-alpha.9 — The Node Stops When Asked

alpha.8 fixed the download but the install still failed, at the next step:
"Docker could not complete this step. Open Docker Desktop, check that it is
running" — shown while Docker was running and healthy.

- **The Node shuts down instead of being killed.** Every stop ended in
  `exit 137`, a SIGKILL after the grace period expired, because shutdown never
  finished. One teardown step waited up to **10 seconds** for an aborted startup
  to unwind, which is Docker's entire default `stop_grace_period` spent inside a
  single step. The Node writes a 30 MB state file, so a SIGKILL could truncate
  it mid-write. That wait is now 1s, teardown is bounded per step and overall,
  and a stop takes ~2.3s ending in `exit 0`.
- **Shutdown says what it is doing.** The runtime previously logged nothing at
  all between receiving SIGTERM and being killed, so a hang was undiagnosable.
  Each step now logs its outcome and duration, and a stalled step is named.
- **One stuck step no longer skips the rest.** Teardown steps are bounded
  individually, so the GUI socket still closes when the scheduler stalls.
- **Docker's real error reaches the operator.** A failed Compose step reported a
  fixed sentence and discarded Compose's output. The last lines of Docker's own
  output are now included.
- **A slow-stopping Node no longer fails the install.** Upgrading recreates the
  agent; Compose was seen returning non-zero having created the new container
  without starting it while the old one was still being killed. The start step
  retries.

The upgrade path from an older Node is what exposed this: the previous container
took the full grace period to die. Installing over a stopped Node would have
looked fine.

## v0.8.0-alpha.8 — Setup Survives Its Own Progress Output

alpha.7 could not complete a Windows install. Setup stopped at the download step
and reported `Image ipfs/kubo:v0.43.0 Pulling` as the reason it failed, which is
a normal progress line from a pull that was succeeding.

- **The pull no longer aborts on its own output.** `docker compose pull` writes
  progress to stderr, and Windows PowerShell 5.1 wraps every redirected stderr
  line in an `ErrorRecord`. Under the launcher's `Stop` preference the first
  progress line became a terminating error, so the download was abandoned
  seconds after it began even though it exited successfully. The preference is
  now relaxed for the duration of the pull only; the outcome is still taken from
  the exit code, so a genuine download failure is still reported.
- **A native command line is never shown as the reason setup stopped.** Only the
  launcher's own messages are written for the person reading the page; anything
  else now reports which step stopped and that Node data and identity are
  untouched.

This shipped in alpha.7 with the live pull output that made it visible. The
packaging tests asserted the text of the launcher, not its behaviour, so a
construct that reads correctly and fails at runtime passed review. Both defects
above now have regression tests that fail against the alpha.7 launcher.

## v0.8.0-alpha.7 — Setup You Can Watch

Windows setup is browser-first. An experienced operator reported that install
"did not connect", when the Node had in fact registered and was sending healthy
heartbeats: nothing ever said so. Every defect below made a working install look
like a failed one.

- **Progress you can see.** The launcher opens one local page reporting each
  step: Docker check, runtime download (with live output from the pull, the
  multi-minute part), starting, waiting for the Node, hand-off. This previously
  ran behind a hidden console while a dialog said only "Starting...".
- **No premature browser tab.** Setup used to open the Node address immediately
  after `up -d`, before anything was listening, so the first thing a person saw
  was a connection error. The launcher now waits until the Node answers.
- **An ending.** The setup page no longer stops at "Node is restarting". It
  watches for the configured runtime to come back, then states that the Node is
  connected and links to the dashboard.
- **`/setup` no longer 404s.** After setup, the runtime redirects it to the
  dashboard, so a refreshed tab lands somewhere real.
- **No terminal.** `Start-KubusNodeSetup.cmd` hands to a hidden PowerShell and
  exits instead of leaving a console window open.
- **Failures are visible**, in plain language, and state that Node data and
  identity are untouched.
- **Manage is separate.** Stopping the Node and the explicit delete-data path
  moved to their own "Manage kubus Node" entry.

All launcher text is ASCII: Windows PowerShell reads `.ps1` as ANSI unless it
carries a BOM, so typographic punctuation rendered as mojibake in the page.

## v0.8.0-alpha.6 — Remote Connection Diagnostics

- **Relay visibility for operators:** Settings → Technical details lists every connected art.kubus device and how it is carried — a direct peer connection or a TURN relay — from the WebRTC selected candidate pair. Only candidate kinds are shown (`host`, `srflx`, `prflx`, `relay`; `udp`, `tcp`, `tls`); no address, port or candidate line is ever displayed or logged, and relay vocabulary stays out of every headline.
- **Operator log line:** each established remote connection logs `webrtc route established` with its route, candidate kinds and the first eight characters of the session id, which is the same session the backend embeds in the TURN credential username.

## v0.8.0-alpha.5 — Account-Authorized Setup

- **Account-authorized setup:** ordinary setup no longer asks for a scoped operator token. The Node starts an installation signed by its Ed25519 identity, the account holder authorizes it with the setup code in art.kubus, and the Node collects its credential by proving the same identity. Manual token entry remains only under Advanced setup.
- **Explicit permission rotation:** a Node paired before the current scope contract can be re-credentialed from the app without changing its Node ID, Ed25519 identity, pairings, captures or archive. The superseded credential is retired only after the replacement is durably stored.
- **Known issue:** the npm publication step failed — `@kubus/kubus-node` has no trusted publisher registered on npmjs.com — so the tarball is available only as a GitHub release asset.

## v0.8.0-alpha.4 — Spatial Network Integration

This alpha completes the integrity and product pass for real spatial-network testing:

- **Participation integrity:** a fresh node must successfully reconcile the public archive, meet the active policy, and receive an accepted heartbeat before spatial processing is enabled. A heartbeat alone never establishes participation. Grace access is available only to a previously verified contributor.
- **Distributed compute:** remote completion uses signed provider output receipts and signed requester acknowledgements, with exact job, input, specification, output CID, timestamp, and protocol binding. The backend also verifies output retrievability before compute contribution can be recorded.
- **Spatial archive:** the art.kubus app exposes canonical spatial captures through an artwork viewer, an archival history, and subtle map discovery indicators.
- **Privacy:** raw captures stay in local private storage by default; remote input is encrypted in transit and at rest in IPFS, while the selected provider temporarily sees plaintext during processing. Unpublished processed output in ordinary Kubo is unlisted and non-canonical, but is not cryptographically private from someone who knows its CID. Published variants are public, canonical, and replicated.
- **Operator and app UX:** joining, degraded grace, pairing, provider choice, processing stages, result review, explicit publication, and separate archive/compute contribution surfaces use consistent English and Slovenian copy.
