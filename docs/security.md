# Security

Never expose Kubo RPC (`5001`) or the Kubo WebUI to the public internet. Kubo RPC is an admin API. Docker Compose keeps RPC/WebUI internal and only binds the Kubo gateway to `127.0.0.1:8080`. In production, `IPFS_RPC_URL` must be loopback, a private-network address, or a Docker-internal hostname.

Never paste seed phrases, private keys, or live operator tokens into docs, logs, issue trackers, or local state. `KUBUS_OPERATOR_TOKEN` is an opaque scoped token created in art.kubus, read from env, and redacted from logs. It can register nodes, send heartbeats, write/read commitments, and read reward status; it cannot spend wallet funds.

The full scoped token is shown once in art.kubus. Later views display only the token prefix, expiry, status, and last-used time. Revoke lost or retired tokens from the same Availability Node setup screen.

Heartbeats are not proof. They only report liveness and diagnostics. The runtime issues or renews a useful-operation lease only when an accepted heartbeat coincides with synchronized, successfully reconciled public pins and every other participation requirement. A never-verified node cannot enter degraded grace. Backend verification and scoring independently determine reward eligibility.

Arbitrary CIDs are not rewardable. The node only commits CIDs returned by the canonical public-object registry. Dev seed CID mode can pin a CID locally, but it does not create a backend rewardable commitment.

`KUBUS_AUTH_MODE` is `bearer` only in v1. Bearer transport carries the scoped `kubus_node_...` token, not a copied app JWT. `KUBUS_SKIP_PINNING` is development-only because it bypasses local pin and retrieval enforcement before commitments.

Firewall expectation: expose only the intended public gateway or reverse proxy. Keep Kubo RPC, local state, and backend credentials private.

## Local GUI Security

The Kubus Node GUI is local/private by default. In Docker, `NODE_GUI_HOST=0.0.0.0` binds the GUI inside the container so Docker can publish it, but Docker Compose maps the host port only as `127.0.0.1:8787:8787`. `http://my.node.kubus.site:8787/gui` works only after the operator adds a hosts-file alias to `127.0.0.1`. Do not create public DNS for `my.node.kubus.site`.

If `NODE_GUI_HOST=0.0.0.0` or `NODE_GUI_ALLOW_REMOTE=true`, the agent refuses to start the GUI unless `NODE_GUI_TOKEN` is set. Browser API calls then require `Authorization: Bearer <NODE_GUI_TOKEN>` or the in-memory local session cookie. The GUI token is separate from `KUBUS_OPERATOR_TOKEN`, cannot spend funds, and is not stored in local node state.

GUI responses and logs redact `kubus_node_...` tokens, Authorization headers, token/secret/private-key/seed fields, and backend credentials. The GUI can run safe node operations but cannot spend funds, export keys, handle seed phrases, submit arbitrary rewardable CIDs, or settle KUB8 payouts.

## Pairing and private spatial data

The LAN API is disabled unless configured explicitly. The admin GUI stays localhost-only. The GUI creates pairing sessions through its authenticated internal action; direct local-API pairing creation always requires the separate GUI token, including on loopback, so a reverse proxy cannot mint credentials. Exchange secrets expire and cannot be replayed. Device credentials have only local content/capture/job/spatial scopes and are hashed at rest. Operator credentials, node keys, wallet keys, and settlement credentials are never returned by `/local/v1`.

Browser origins are rejected to prevent arbitrary LAN websites from calling the API. Pairing and bearer secrets must not be placed in query strings. Logs and heartbeat metadata exclude local paths, filenames, raw frames, pairing credentials, and operator secrets.

Capture directories and worker job outputs live below the configured private data root with restrictive permissions and safe relative-path validation. Raw captures never enter Kubo. Processed variants are added to ordinary local Kubo for content-addressed review but do not enter the network-managed public replica set until explicit publication; those unpublished CIDs are unlisted rather than cryptographically private. Deletion is blocked while an active job references a capture. Publication sends selected processed CID metadata to the backend; it never sends raw capture bytes.

## Distributed-compute threat model

| Threat | Implemented protection | Residual limit |
|---|---|---|
| Malicious LAN client or leaked pairing token | LAN API off by default, origin rejection, scoped hashed credentials, bounded bodies, no query tokens | A stolen live scoped token works until credentials are reset |
| Malicious requester / archive bomb | Backend job lease and quotas; ciphertext/input limit; authenticated decryption; safe relative paths; declared-file and expanded-byte limits | A provider still spends some bandwidth before rejecting malicious ciphertext |
| Malicious provider | Explicit user choice, provider identity keys, signed receipts, output CID verification, requester acknowledgement | Provider sees plaintext and can return poor-but-parseable output; alpha disputes need operator review |
| Receipt replay or duplicate completion | Job/spec/input/output binding, Ed25519 signature, legal transitions and unique reward record | Sybil identities are not fully prevented |
| Forged completion or arbitrary reward CID | Backend-issued lease, retrievability check, requester receipt and canonical public-object registry | Gateway/IPFS reachability is a point-in-time observation |
| Path traversal or worker command injection | No shell interpolation; fixed worker job types; root-confined paths; manifest path validation | Nerfstudio and parsers process untrusted media inside the worker container |
| Oversized input/output | Local JSON limits, provider configured byte cap, extraction cap and backend job caps | GPU memory exhaustion can still fail an otherwise valid job |
| Kubo RPC exposure | Compose-private RPC and documented private-host validation | Operator firewall or custom Compose changes can defeat this boundary |
| Stale discovery | Fresh heartbeat, contributing lease, worker health and queue checks; provider rechecks gate/capacity on acceptance | State can change after matching and is handled as decline/failure |
| Encrypted payload persistence | Job-specific directory, cleanup in success/failure, input unpin | Backups, filesystem recovery, crash dumps and malicious providers prevent a hard deletion guarantee |
| Backend compromise | Backend never receives plaintext key; node verifies authenticated ciphertext and provider identity binding | A compromised control plane can mis-match providers or censor jobs and owns canonical/reward policy |

Compute node keys are generated with Node.js standard X25519 and Ed25519 primitives and stored in local state with the same protection as node identity. AES-256-GCM provides payload and key-envelope authenticity; HKDF-SHA-256 domain-separates the wrapping key. Raw keys, envelopes containing private material, pairing secrets and authorization headers are excluded from heartbeat and logs.
