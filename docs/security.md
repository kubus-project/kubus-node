# Security

Never expose Kubo RPC (`5001`) or the Kubo WebUI to the public internet. Kubo RPC is an admin API. Docker Compose keeps RPC/WebUI internal and only binds the Kubo gateway to `127.0.0.1:8080`. In production, `IPFS_RPC_URL` must be loopback, a private-network address, or a Docker-internal hostname.

Never paste seed phrases, private keys, or live operator tokens into docs, logs, issue trackers, or local state. `KUBUS_OPERATOR_TOKEN` is an opaque scoped token created in art.kubus, read from env, and redacted from logs. It can register nodes, send heartbeats, write/read commitments, and read reward status; it cannot spend wallet funds.

The full scoped token is shown once in art.kubus. Later views display only the token prefix, expiry, status, and last-used time. Revoke lost or retired tokens from the same Availability Node setup screen.

Heartbeats are not proof. They only report liveness and diagnostics. Backend verification and scoring determine reward eligibility.

Arbitrary CIDs are not rewardable. The node only commits CIDs returned by the canonical public-object registry. Dev seed CID mode can pin a CID locally, but it does not create a backend rewardable commitment.

`KUBUS_AUTH_MODE` is `bearer` only in v1. Bearer transport carries the scoped `kubus_node_...` token, not a copied app JWT. `KUBUS_SKIP_PINNING` is development-only because it bypasses local pin and retrieval enforcement before commitments.

Firewall expectation: expose only the intended public gateway or reverse proxy. Keep Kubo RPC, local state, and backend credentials private.

## Local GUI Security

The Kubus Node GUI is local/private by default. In Docker, `NODE_GUI_HOST=0.0.0.0` binds the GUI inside the container so Docker can publish it, but Docker Compose maps the host port only as `127.0.0.1:8787:8787`. `http://my.node.kubus.site:8787/gui` works only after the operator adds a hosts-file alias to `127.0.0.1`. Do not create public DNS for `my.node.kubus.site`.

If `NODE_GUI_HOST=0.0.0.0` or `NODE_GUI_ALLOW_REMOTE=true`, the agent refuses to start the GUI unless `NODE_GUI_TOKEN` is set. Browser API calls then require `Authorization: Bearer <NODE_GUI_TOKEN>` or the in-memory local session cookie. The GUI token is separate from `KUBUS_OPERATOR_TOKEN`, cannot spend funds, and is not stored in local node state.

GUI responses and logs redact `kubus_node_...` tokens, Authorization headers, token/secret/private-key/seed fields, and backend credentials. The GUI can run safe node operations but cannot spend funds, export keys, handle seed phrases, submit arbitrary rewardable CIDs, or settle KUB8 payouts.
