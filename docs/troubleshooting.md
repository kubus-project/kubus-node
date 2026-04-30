# Troubleshooting

Backend auth failure: verify `KUBUS_OPERATOR_TOKEN` starts with `kubus_node_`, has not expired or been revoked in art.kubus, and belongs to `KUBUS_OPERATOR_WALLET`.

Kubo not reachable: check `IPFS_RPC_URL`, Docker service health, and that the agent is not using `localhost` from inside a container.

Docker state volume permission error (`EACCES` writing `/var/lib/kubus-node/.state.json.<pid>.<timestamp>.tmp`): this usually means an existing `node-state` volume was created by root before the image started pre-owning the directory. Stop the stack, run the recovery command below, and then restart Docker Compose.

```sh
docker compose run --rm --user root --entrypoint sh kubus-node-agent -lc "mkdir -p /var/lib/kubus-node && chown -R node:node /var/lib/kubus-node"
```

If you use `docker compose down -v` or remove `node-state`, remember that it resets the generated node key and local node identity. Do not delete volumes casually unless you intend to re-register the node.

Kubo UDP receive buffer warning: this is non-fatal. On Linux, raise the kernel buffers if you want to silence it, for example with `net.core.rmem_max = 2500000` and `net.core.wmem_max = 2500000`.

Kubo outdated warning: this is also non-fatal. The image is pinned intentionally in `docker-compose.yml`; if you want a newer Kubo release, update the tag deliberately after reviewing the release notes, then rebuild the stack.

No rewardable CIDs: this is valid before canonical public objects are published. In production smoke fails; in development set `KUBUS_DEV_ALLOW_EMPTY_CIDS=true` to verify empty-state behavior.

Pin failure: inspect Kubo logs and repo storage. The CID must be retrievable from IPFS or already present locally.

Commitment rejected: confirm the CID came from `/api/availability/rewardable-cids`, the node belongs to the token wallet, and the token includes `availability:commitments:write`.

Heartbeat rejected: confirm `nodeId` is registered to the token wallet, the token includes `availability:nodes:heartbeat`, and status is one of `healthy`, `degraded`, `offline`, or `syncing`.

Status stale: check scheduler logs, backend health, and heartbeat interval.

Docker volume reset: stop compose, remove the target volume, and start again. Removing `node-state` loses generated node key and registration identity.
