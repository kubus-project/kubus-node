# Troubleshooting

Backend auth failure: verify `KUBUS_OPERATOR_TOKEN` starts with `kubus_node_`, has not expired or been revoked in art.kubus, and belongs to `KUBUS_OPERATOR_WALLET`.

Kubo not reachable: check `IPFS_RPC_URL`, Docker service health, and that the agent is not using `localhost` from inside a container. Kubo RPC/WebUI on `5001` is intentionally private and is not the Kubus Node GUI.

Docker state volume permission error (`EACCES` writing `/var/lib/kubus-node/.state.json.<pid>.<timestamp>.tmp`): this usually means an existing `node-state` volume was created by root before the image started pre-owning the directory. Stop the stack, run the recovery command below, and then restart Docker Compose.

```sh
docker compose run --rm --user root --entrypoint sh kubus-node-agent -lc "mkdir -p /var/lib/kubus-node && chown -R node:node /var/lib/kubus-node"
```

If you use `docker compose down -v` or remove `node-state`, remember that it resets the generated node key and local node identity. Do not delete volumes casually unless you intend to re-register the node.

Kubo UDP receive buffer warning: this is non-fatal. On Linux, raise the kernel buffers if you want to silence it, for example with `net.core.rmem_max = 2500000` and `net.core.wmem_max = 2500000`.

Kubo outdated warning: this is also non-fatal. The image is pinned intentionally in `docker-compose.yml`; if you want a newer Kubo release, update the tag deliberately after reviewing the release notes, then rebuild the stack.

No rewardable CIDs: this is valid before canonical public objects are published. In production smoke fails; in development set `KUBUS_DEV_ALLOW_EMPTY_CIDS=true` to verify empty-state behavior.

Public pin-set empty: call `/api/availability/public-pin-set`. If it returns `count: 0`, the live backend currently has no active canonical public CID rows in `public_object_cids`, or publication flows are not creating them. Do not add fake CIDs to the node.

Pinned count stays zero: run `npm run dev -- sync`, `npm run dev -- pin`, and `npm run dev -- heartbeat`. If tracked remains zero, the pin set is empty. If tracked is nonzero and pinned is zero, check Kubo reachability, gateway retrieval, and the failed pin list in the GUI Pinning section.

Pin failure: inspect Kubo logs and repo storage. The CID must be retrievable from IPFS or already present locally.

Commitment rejected: confirm the CID came from `/api/availability/rewardable-cids`, the node belongs to the token wallet, and the token includes `availability:commitments:write`.

Heartbeat rejected: confirm `nodeId` is registered to the token wallet, the token includes `availability:nodes:heartbeat`, and status is one of `healthy`, `degraded`, `offline`, or `syncing`.

Status stale: check scheduler logs, backend health, and heartbeat interval.

Docker volume reset: stop compose, remove the target volume, and start again. Removing `node-state` loses generated node key and registration identity.

GUI cannot connect to backend: open `http://127.0.0.1:8787/gui`, run Doctor, and check Backend health plus Public pin-set endpoint. Confirm `KUBUS_API_BASE_URL` and `KUBUS_OPERATOR_TOKEN` are set.

GUI auth token rejected: confirm the browser token matches `NODE_GUI_TOKEN`. The GUI token is not the `kubus_node_...` operator token.

GUI does not open from Docker: ensure `NODE_GUI_ENABLED=true`, `NODE_GUI_HOST=0.0.0.0`, `NODE_GUI_PORT=8787`, and `NODE_GUI_TOKEN` is set. The agent binds to `0.0.0.0` inside the container, while Docker publishes only `127.0.0.1:8787:8787` on the host. If the agent binds to container-local `127.0.0.1`, the host port may not reach it.

`my.node.kubus.site` does not resolve: add the local hosts entry. Linux/macOS: `sudo sh -c 'echo "127.0.0.1 my.node.kubus.site" >> /etc/hosts'`. Windows PowerShell as Administrator: `Add-Content -Path "$env:SystemRoot\System32\drivers\etc\hosts" -Value "`n127.0.0.1 my.node.kubus.site"`. The fallback URL is `http://127.0.0.1:8787/gui`.

Kubo not reachable from GUI Doctor: inside Docker, use `IPFS_RPC_URL=http://kubo:5001`. On the host, use the loopback Kubo RPC only if you intentionally run Kubo locally. Never expose Kubo RPC port 5001 publicly. The Kubus Node GUI is on `8787`; the Kubo WebUI is on Kubo RPC port `5001` and remains private.
