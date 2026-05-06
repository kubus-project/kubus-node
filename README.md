# Kubus Node

Kubus Node is the operator runtime for the Kubus Availability Network. It runs next to a private Kubo daemon, registers an operator node with the Kubus backend control plane, pins canonical public Kubus CIDs, submits availability commitments for the rewardable subset, sends liveness heartbeats, and reports status/reward summaries.

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

Docker Compose keeps the Kubo RPC API and Kubo WebUI on port `5001` private inside the stack; only the local Kubo gateway on `8080` and the Kubus Node GUI on `8787` are published to host loopback. The agent runs as the non-root `node` user, so a fresh `node-state` volume must be writable. If you are reusing an older root-owned volume, see the troubleshooting recovery command before restarting the stack.

Useful commands:

```sh
npm run status
npm run doctor
npm run gui
npm run smoke
npm run start
```

## Public Archive Pinning

The node mirrors `/api/availability/public-pin-set`, not only `/api/availability/rewardable-cids`. The public pin set includes active canonical public manifest CIDs, public record CIDs, metadata CIDs, media/image CIDs, AR asset CIDs, and rewardable leaf CIDs. The rewardable endpoint remains a subset used for commitments and KUB8 scoring.

The node never mirrors drafts, private profile fields, private messages, wallet backups, auth/session data, admin data, raw database dumps, deleted/unpublished objects, arbitrary node-submitted CIDs, or third-party URL-only assets without an IPFS/public CID.

## Local GUI

Enable the local GUI with:

```sh
NODE_GUI_ENABLED=true
NODE_GUI_HOST=0.0.0.0
NODE_GUI_PORT=8787
NODE_GUI_TOKEN=change-this-local-gui-password
NODE_GUI_ALLOW_REMOTE=false
NODE_GUI_DISPLAY_URL=http://my.node.kubus.site:8787/gui
```

Then open `http://my.node.kubus.site:8787/gui` after adding a local hosts-file alias, or use the fallback `http://127.0.0.1:8787/gui`. The hostname is local-only and is not public DNS.

Docker uses `NODE_GUI_HOST=0.0.0.0` inside the container so Docker port publishing can reach the GUI process. The host publish remains loopback-only as `127.0.0.1:8787:8787`, so the GUI is still local to the operator machine. Because `0.0.0.0` is a broad container bind, `NODE_GUI_TOKEN` is required. The token protects GUI actions and cannot spend funds.

Linux/macOS:

```sh
sudo sh -c 'echo "127.0.0.1 my.node.kubus.site" >> /etc/hosts'
```

Windows PowerShell as Administrator:

```powershell
Add-Content -Path "$env:SystemRoot\System32\drivers\etc\hosts" -Value "`n127.0.0.1 my.node.kubus.site"
```

The GUI shows Overview, Pinning, Rewards, Commitments, Logs, and Doctor sections. It can trigger safe local sync, pin reconcile, commitment refresh, heartbeat, and doctor actions. It cannot spend funds, export wallet keys, or settle payouts. This is different from the Kubo WebUI: Kubo WebUI/RPC on `5001` stays private and is intentionally not exposed by Docker Compose.

## Environment

Required values are documented in `.env.example`. `KUBUS_OPERATOR_TOKEN` is an opaque scoped token in the `kubus_node_...` format, created in art.kubus and sent as `Authorization: Bearer <token>`. It is not a normal app session JWT, does not control a wallet, and is never written to local state. If `KUBUS_NODE_KEY` is absent, the agent generates a persistent node key and stores it in `LOCAL_STATE_PATH`.

Dev-only options such as `KUBUS_DEV_SEED_CID`, `KUBUS_DEV_ALLOW_EMPTY_CIDS`, and `KUBUS_SKIP_PINNING` are rejected in production. `KUBUS_AUTH_MODE` is currently `bearer` only.

## Logs And State

Logs are structured with pino and redact token fields. Local state is an atomic JSON snapshot containing node identity, peer ID, policy, CID snapshots, pin/commitment state, heartbeats, status, epoch, and reward summaries. It intentionally excludes tokens and private keys.

## Upgrading

Stop the agent, back up `LOCAL_STATE_PATH` and the Kubo volume, install the new package/container, then start the agent. Keep the same node key and operator wallet unless rotating intentionally. To rotate auth, create a new operator token in art.kubus, update `.env`, restart the node, then revoke the old token.

## Known Limitations

The node only consumes node-facing Phase 7 availability APIs. Backend verification/scoring decides reward eligibility. Empty rewardable CID lists are valid in development and fail smoke only in production.
