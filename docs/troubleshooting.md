# Troubleshooting

Backend auth failure: verify `KUBUS_OPERATOR_TOKEN`, backend `JWT_SECRET`, token expiry, and wallet identity.

Kubo not reachable: check `IPFS_RPC_URL`, Docker service health, and that the agent is not using `localhost` from inside a container.

No rewardable CIDs: this is valid before canonical public objects are published. In production smoke fails; in development set `KUBUS_DEV_ALLOW_EMPTY_CIDS=true` to verify empty-state behavior.

Pin failure: inspect Kubo logs and repo storage. The CID must be retrievable from IPFS or already present locally.

Commitment rejected: confirm the CID came from `/api/availability/rewardable-cids` and the node belongs to the token wallet.

Heartbeat rejected: confirm `nodeId` is registered to the token wallet and status is one of `healthy`, `degraded`, `offline`, or `syncing`.

Status stale: check scheduler logs, backend health, and heartbeat interval.

Docker volume reset: stop compose, remove the target volume, and start again. Removing `node-state` loses generated node key and registration identity.
