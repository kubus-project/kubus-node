# Security

Never expose Kubo RPC (`5001`) to the public internet. It is an admin API. Docker Compose keeps RPC internal and only binds the gateway to `127.0.0.1`. In production, `IPFS_RPC_URL` must be loopback, a private-network address, or a Docker-internal hostname.

Never paste seed phrases, private keys, or live operator tokens into docs, logs, issue trackers, or local state. `KUBUS_OPERATOR_TOKEN` is an opaque scoped token created in art.kubus, read from env, and redacted from logs. It can register nodes, send heartbeats, write/read commitments, and read reward status; it cannot spend wallet funds.

The full scoped token is shown once in art.kubus. Later views display only the token prefix, expiry, status, and last-used time. Revoke lost or retired tokens from the same Availability Node setup screen.

Heartbeats are not proof. They only report liveness and diagnostics. Backend verification and scoring determine reward eligibility.

Arbitrary CIDs are not rewardable. The node only commits CIDs returned by the canonical public-object registry. Dev seed CID mode can pin a CID locally, but it does not create a backend rewardable commitment.

`KUBUS_AUTH_MODE` is `bearer` only in v1. Bearer transport carries the scoped `kubus_node_...` token, not a copied app JWT. `KUBUS_SKIP_PINNING` is development-only because it bypasses local pin and retrieval enforcement before commitments.

Firewall expectation: expose only the intended public gateway or reverse proxy. Keep Kubo RPC, local state, and backend credentials private.
