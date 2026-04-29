# API Contract

Base path: `${KUBUS_API_BASE_URL}/api/availability`.

Auth: node write/read ownership routes use `Authorization: Bearer <KUBUS_OPERATOR_TOKEN>`. The token is an opaque scoped `kubus_node_...` operator token created in art.kubus. Backend verification binds it to one wallet, checks expiry/revocation, and enforces route scopes.

Health:

- `GET /health/ready`, with `GET /health` fallback for older/local backend wiring.

Public reads:

- `GET /kub8-utility`
- `GET /policies`
- `GET /rewardable-cids?limit=&offset=&type=&id=&cid=`
- `GET /epochs/current`

Node routes:

- `POST /nodes/register` with `{ nodeKey, endpointUrl, label, status, metadata }`
- `GET /nodes/current`
- `GET /nodes/me`
- `POST /heartbeat` with `{ nodeId, peerId, agentVersion, kuboHealth, storage, trackedCidCount, pinnedCidCount, failedCidCount, status, metadata }`
- `POST /nodes/:nodeId/heartbeat` with the same heartbeat body except `nodeId` is in the path
- `GET /nodes/:nodeId/status`
- `GET /nodes/:nodeId/heartbeat/latest`
- `POST /commitments` with `{ nodeId, rewardableCidId, cid, expiresAt, metadata }`
- `POST /nodes/:nodeId/commitments` with `{ rewardableCidId, cid, expiresAt, metadata }`
- `GET /commitments/current?nodeId=...`
- `GET /nodes/:nodeId/commitments`
- `GET /rewards/me?status=&limit=&offset=`

Responses usually wrap data as `{ success: true, data }`. Validation/auth failures are terminal. `503 NODE_NOT_WRITABLE` means the backend is a standby or writes are disabled for this route. `GET /epochs/current` can return `{ epoch: null }`.
