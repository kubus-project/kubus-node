# API Contract

Base path: `${KUBUS_API_BASE_URL}/api/availability`.

Auth: node write/read ownership routes use `Authorization: Bearer <KUBUS_OPERATOR_TOKEN>`. The token is an opaque scoped `kubus_node_...` operator token created in art.kubus. Backend verification binds it to one wallet, checks expiry/revocation, and enforces route scopes.

Health:

- `GET /health/ready`, with `GET /health` fallback for older/local backend wiring.

Public reads:

- `GET /kub8-utility`
- `GET /policies`
- `GET /public-pin-set?limit=&offset=&entityType=&entityId=&cid=&role=&family=&verificationClass=&rewardableOnly=&changedSince=`
- `GET /pin-set` and `GET /public-cids` as aliases for the public pin set
- `GET /rewardable-cids?limit=&offset=&type=&id=&cid=`
- `GET /epochs/current`

Node routes:

- `POST /nodes/register` with `{ nodeKey, endpointUrl, label, status, metadata }`
- `GET /nodes/current`
- `GET /nodes/me`
- `POST /heartbeat` with `{ nodeId, peerId, agentVersion, kuboHealth, storage, trackedCidCount, pinnedCidCount, failedCidCount, status, metadata }`; counts describe the desired public pin set, while rewardable counts and bundle details live in `metadata`
- `POST /nodes/:nodeId/heartbeat` with the same heartbeat body except `nodeId` is in the path
- `GET /nodes/:nodeId/status`
- `GET /nodes/:nodeId/heartbeat/latest`
- `POST /commitments` with `{ nodeId, rewardableCidId, cid, expiresAt, metadata }`
- `POST /nodes/:nodeId/commitments` with `{ rewardableCidId, cid, expiresAt, metadata }`
- `GET /commitments/current?nodeId=...`
- `GET /nodes/:nodeId/commitments`
- `GET /rewards/me?status=&limit=&offset=`

Responses usually wrap data as `{ success: true, data }`. Validation/auth failures are terminal. `503 NODE_NOT_WRITABLE` means the backend is a standby or writes are disabled for this route. `GET /epochs/current` can return `{ epoch: null }`.

Pinning and rewards are distinct. Nodes mirror the public pin set from `/public-pin-set`; reward commitments are created only for active rows from `/rewardable-cids`. Commitment metadata includes pinned bundle CIDs plus manifest, record, and leaf pin booleans for the object/version under verification.

Local GUI endpoints are served by kubus-node itself, not the Kubus backend:

- `GET /gui`
- `GET /gui/api/status`
- `GET /gui/api/pinning`
- `GET /gui/api/rewards`
- `GET /gui/api/commitments`
- `GET /gui/api/logs`
- `DELETE /gui/api/logs`
- `POST /gui/api/actions/sync`
- `POST /gui/api/actions/pin`
- `POST /gui/api/actions/commitments`
- `POST /gui/api/actions/heartbeat`
- `POST /gui/api/actions/doctor`

The GUI is local-only by default at `http://my.node.kubus.site:8787/gui` with fallback `http://127.0.0.1:8787/gui`. If it is exposed beyond localhost, `NODE_GUI_TOKEN` is required and GUI API calls must send `Authorization: Bearer <NODE_GUI_TOKEN>`.
