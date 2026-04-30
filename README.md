# Kubus Node

Kubus Node is the operator runtime for the Kubus Availability Network. It runs next to a private Kubo daemon, registers an operator node with the Kubus backend control plane, pins canonical rewardable CIDs, submits availability commitments, sends liveness heartbeats, and reports status/reward summaries.

It is not a payout engine, platform settlement bridge, wallet, or proof oracle. Availability rewards remain pending backend control-plane records until the generic platform-settlement bridge exists.

## Quick Start

1. Install Node.js 20+ and Docker.
2. In art.kubus, open Settings > Wallet > Availability Node and create a scoped operator token for the wallet that will run the node.
3. Copy `.env.example` to `.env`.
4. Paste the one-time token into `KUBUS_OPERATOR_TOKEN` and fill the remaining values: wallet, node label/endpoint, Kubo RPC/gateway URLs, state path, log level, intervals, CID class filters, pin limit, and `NODE_ENV`.
5. Run `npm install`.
6. Run `npm run build && npm run smoke`.

Docker:

```sh
docker compose up --build
```

Docker Compose keeps the Kubo RPC API private inside the stack; only the local gateway is exposed for verification. The agent runs as the non-root `node` user, so a fresh `node-state` volume must be writable. If you are reusing an older root-owned volume, see the troubleshooting recovery command before restarting the stack.

Useful commands:

```sh
npm run status
npm run doctor
npm run smoke
npm run start
```

## Environment

Required values are documented in `.env.example`. `KUBUS_OPERATOR_TOKEN` is an opaque scoped token in the `kubus_node_...` format, created in art.kubus and sent as `Authorization: Bearer <token>`. It is not a normal app session JWT, does not control a wallet, and is never written to local state. If `KUBUS_NODE_KEY` is absent, the agent generates a persistent node key and stores it in `LOCAL_STATE_PATH`.

Dev-only options such as `KUBUS_DEV_SEED_CID`, `KUBUS_DEV_ALLOW_EMPTY_CIDS`, and `KUBUS_SKIP_PINNING` are rejected in production. `KUBUS_AUTH_MODE` is currently `bearer` only.

## Logs And State

Logs are structured with pino and redact token fields. Local state is an atomic JSON snapshot containing node identity, peer ID, policy, CID snapshots, pin/commitment state, heartbeats, status, epoch, and reward summaries. It intentionally excludes tokens and private keys.

## Upgrading

Stop the agent, back up `LOCAL_STATE_PATH` and the Kubo volume, install the new package/container, then start the agent. Keep the same node key and operator wallet unless rotating intentionally. To rotate auth, create a new operator token in art.kubus, update `.env`, restart the node, then revoke the old token.

## Known Limitations

The node only consumes node-facing Phase 7 availability APIs. Backend verification/scoring decides reward eligibility. Empty rewardable CID lists are valid in development and fail smoke only in production.
