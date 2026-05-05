# Operator Guide

Install Node.js 20+ and Docker. In art.kubus, sign in with the operator wallet and open Settings > Wallet > Availability Node. Create a scoped operator token, copy it once, and paste it into `.env` as `KUBUS_OPERATOR_TOKEN`.

Configure every required value in `.env.example`, then run:

```sh
npm install
npm run build
```

Start locally:

```sh
npm run start
```

For development without a build:

```sh
npm run dev
```

Start with Docker:

```sh
docker compose up --build
```

Kubo may migrate an existing `/data/ipfs` repository on first start after an image upgrade. A migration from fs-repo 16 to 18 is expected for Kubo 0.41.0 when it completes successfully. The compose stack disables Kubo anonymous telemetry with `IPFS_TELEMETRY=off`.

If Kubo logs a QUIC UDP receive-buffer warning, the node can still run. Operators who expose public swarm UDP traffic can improve QUIC performance by raising host UDP buffer limits before starting Docker:

```sh
sudo sysctl -w net.core.rmem_max=7500000 net.core.wmem_max=7500000
```

Check state:

```sh
npm run status
npm run doctor
```

Maintenance commands:

```sh
npm run status
npm run doctor
npm run smoke
npm run dev -- register
npm run dev -- sync
npm run dev -- pin
npm run dev -- heartbeat
npm run dev -- rewards
```

Backups:

- Back up the Docker volume `kubo-data`.
- Back up `LOCAL_STATE_PATH` or the `node-state` volume.
- Do not delete either volume unless you intend to reset local IPFS and node identity state. Removing `node-state` clears the generated node key and registration identity; removing `kubo-data` resets the Kubo repository.

Reset local node state by stopping the agent and deleting the local state file. This generates a new node key unless `KUBUS_NODE_KEY` is configured.

The agent container runs as the non-root `node` user. If a reused `node-state` volume is owned by root, fix the ownership with the troubleshooting recovery command and restart the stack.

Rotate token by creating a new scoped operator token in art.kubus, stopping the agent, replacing `KUBUS_OPERATOR_TOKEN`, and restarting. Revoke the old token after the new node status is healthy. Do not change the operator wallet unless registering a new operator identity.

Expected resources depend on the public pin set size. `MAX_PINNED_CIDS` caps all canonical public CIDs mirrored by the node, including manifest and record CIDs that are not rewardable. `CID_CLASS_FILTERS` narrows classed pin-set records and reward commitments, but records without a class are still pinned so canonical public metadata is not accidentally excluded. Start with `MAX_PINNED_CIDS=100`, keep Kubo storage monitored, and raise slowly.
