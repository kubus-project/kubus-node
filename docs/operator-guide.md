# Operator Guide

Install Node.js 20+ and Docker. Configure every required value in `.env.example`, then run:

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

Reset local node state by stopping the agent and deleting the local state file. This generates a new node key unless `KUBUS_NODE_KEY` is configured.

Rotate token by stopping the agent, replacing `KUBUS_OPERATOR_TOKEN`, and restarting. Do not change the operator wallet unless registering a new operator identity.

Expected resources depend on CID count. Start with `MAX_PINNED_CIDS=100`, keep Kubo storage monitored, and raise slowly.
