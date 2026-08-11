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

Start the current NVIDIA/CUDA spatial worker profile:

```sh
docker compose --profile spatial up --build
```

The worker has no published host port. NVIDIA Container Toolkit and a compatible NVIDIA driver are required; CPU reconstruction is not supported. Remote GPU sharing is optional and can be enabled or paused from the paired art.kubus dashboard. Archive participation is always required. Environment defaults and hard bounds are documented in `.env.example`.

Kubo may migrate an existing `/data/ipfs` repository on first start after an image upgrade. A migration from fs-repo 16 to 18 is expected for Kubo 0.41.0 when it completes successfully. The compose stack disables Kubo anonymous telemetry with `IPFS_TELEMETRY=off`. Kubo RPC and Kubo WebUI on port `5001` are intentionally not published to the host.

If Kubo logs a QUIC UDP receive-buffer warning, the node can still run. Operators who expose public swarm UDP traffic can improve QUIC performance by raising host UDP buffer limits before starting Docker:

```sh
sudo sysctl -w net.core.rmem_max=7500000 net.core.wmem_max=7500000
```

Check state:

```sh
npm run status
npm run doctor
npm run gui
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

`MAX_PINNED_BYTES` must meet the backend policy's `minimumContributionCapacityBytes`; setting it to a token value does not unlock compute. When the current archive is smaller than committed capacity, the node contributes every eligible available byte and remains policy-compliant. `KUBUS_SKIP_PINNING=true` is rejected as participation in production.

## Local GUI

The local GUI is optional and operator-facing. Enable it in `.env`:

```sh
NODE_GUI_ENABLED=true
NODE_GUI_HOST=0.0.0.0
NODE_GUI_PORT=8787
NODE_GUI_TOKEN=change-this-local-gui-password
NODE_GUI_ALLOW_REMOTE=false
NODE_GUI_DISPLAY_URL=http://my.node.kubus.site:8787/gui
```

Open `http://my.node.kubus.site:8787/gui` after adding a hosts-file alias. The fallback URL is `http://127.0.0.1:8787/gui`.

Linux/macOS:

```sh
sudo sh -c 'echo "127.0.0.1 my.node.kubus.site" >> /etc/hosts'
```

Windows PowerShell as Administrator:

```powershell
Add-Content -Path "$env:SystemRoot\System32\drivers\etc\hosts" -Value "`n127.0.0.1 my.node.kubus.site"
```

For Docker, the GUI must bind to `0.0.0.0:8787` inside the container so Docker can publish the port. The host port is still loopback-bound as `127.0.0.1:8787:8787`, so it remains local-only. Because the container bind is broad, `NODE_GUI_TOKEN` is required whenever the GUI is enabled with this Docker configuration. Tailscale or a reverse proxy is an advanced setup and must still require a GUI token.

The GUI sections are Overview, Pinning, Rewards, Commitments, Logs, and Doctor. Safe actions are sync public pin set, reconcile pins, refresh commitments, send heartbeat, and run doctor checks. The GUI cannot spend funds and never shows `KUBUS_OPERATOR_TOKEN`, Authorization headers, private keys, seed phrases, or raw backend credentials. This Kubus Node GUI is not the Kubo WebUI; Kubo WebUI/RPC on `5001` stays private.
