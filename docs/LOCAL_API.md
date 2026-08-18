# Local API (`local/v1`)

The local API shares services and one HTTP listener with the GUI, but authentication and exposure are separate. JSON responses use `{ "success": true, "data": ... }`. Except pairing bootstrap, requests require `Authorization: Bearer kubus_local_...` and the route scope.

| Method | Path | Scope |
|---|---|---|
| GET | `/local/v1/info` | `content:read` |
| GET | `/local/v1/status` | `content:read` |
| GET | `/local/v1/participation` | `content:read` |
| GET | `/local/v1/capabilities` | `content:read` |
| GET | `/local/v1/network` | `content:read` |
| GET | `/local/v1/storage` | `content:read` |
| GET | `/local/v1/content/:cid` | `content:read` |
| POST | `/local/v1/pairing/session` | GUI admin token (always required) |
| POST | `/local/v1/pairing/exchange` | valid one-time secret |
| POST | `/local/v1/captures` | `captures:create` |
| POST | `/local/v1/captures/drafts` | `captures:create` |
| PUT | `/local/v1/captures/drafts/:id/files?path=` | `captures:create` |
| GET | `/local/v1/captures/drafts/:id` | `captures:read` |
| DELETE | `/local/v1/captures/drafts/:id` | `captures:create` |
| POST | `/local/v1/captures/drafts/:id/commit` | `captures:create` |
| GET/DELETE | `/local/v1/captures/:id` | `captures:read` |
| POST/GET | `/local/v1/jobs` | `jobs:create` / `jobs:read` |
| GET | `/local/v1/jobs/:id` | `jobs:read` |
| POST | `/local/v1/jobs/:id/cancel` | `jobs:create` |
| GET | `/local/v1/spatial/:id` | `spatial:read` |
| POST | `/local/v1/spatial/:id/publish` | `spatial:publish-request` |
| GET/PUT | `/local/v1/compute/settings` | `jobs:read` / `compute:manage` |
| POST | `/local/v1/compute/candidates` | `jobs:read` |
| POST | `/local/v1/compute/jobs` | `jobs:create` |
| POST | `/local/v1/compute/jobs/:id/status` | `jobs:read` |
| POST | `/local/v1/compute/jobs/:id/retrieve` | `jobs:read` |
| POST | `/local/v1/compute/jobs/:id/acknowledge` | `jobs:read` |
| POST | `/local/v1/compute/jobs/:id/cancel` | `jobs:read` |

Pairing secrets expire after `PAIRING_SESSION_TTL_SECONDS`, are single-use, and are stored only as SHA-256 hashes. Local credentials are returned once and stored only as hashes by the node. The Flutter app stores its credential in platform secure storage.

Normal operator activation happens through the authenticated `/gui/api/pairing/session` action. Direct `/local/v1/pairing/session` bootstrap always requires `NODE_GUI_TOKEN`, even from loopback, because a public reverse proxy may itself connect to the node over loopback.

Set `LOCAL_API_ALLOW_LAN=true` intentionally for phone pairing and configure `LOCAL_API_LAN_URL` to a phone-reachable private address. Never advertise loopback or a wildcard bind. For remote access, configure `LOCAL_API_REMOTE_URL` to an operator-managed **HTTPS** reverse proxy or tunnel (Tailscale Serve/Funnel, Cloudflare Tunnel, Caddy/nginx, or an equivalent). The Node API can remain loopback-bound behind that proxy. If a container or host proxy reaches the API from a non-loopback peer, list its exact IP in `LOCAL_API_TRUSTED_PROXY_ADDRESSES`; this permits only that ingress and does not enable general LAN access. Provider choice is not part of the application protocol. Keep the operator GUI localhost/private by default. The API rejects browser `Origin` requests and does not enable permissive CORS. Never put tokens in URLs or logs.

Compute calls that contact the control plane accept the signed-in app's short-lived `backendAuthorization` only in the JSON body over the paired LAN session. The node forwards it and never persists or logs it. Useful compute and private result routes return HTTP `423` with `code: NETWORK_PARTICIPATION_REQUIRED` when no valid participation lease exists. Setup, status, pairing and diagnostics remain available.

The provider-settings update accepts `enabled`, `paused`, `maxConcurrency`, `maxQueueDepth`, `maxAcceptedInputBytes`, and `minimumFreeVramBytes`. Public archive participation is not configurable here and remains mandatory.

## Streaming capture upload

`POST /local/v1/captures` takes the whole package as one JSON document with every file base64 encoded. That inflates the payload by roughly a third on the wire and requires both the client and the node to hold the entire capture in memory, which does not suit a continuous mobile spatial capture.

The draft routes are an additive alternative. The JSON endpoint is unchanged and existing clients keep working.

1. `POST /local/v1/captures/drafts` with the capture metadata (`schema`, `capturedAt`, `metadata`, optional `artworkId`, `markerId`, `retention`) returns a draft `id`.
2. `PUT /local/v1/captures/drafts/:id/files?path=rgb/00000.jpg` sends the file as a **raw binary body**. `Content-Type` is recorded as the file's MIME type unless it is `application/octet-stream`. Each request is capped at 128 MiB.
3. `GET /local/v1/captures/drafts/:id` reports `fileCount`, `sizeBytes` and the paths received so far, so an interrupted transfer can resume without re-sending what already landed. Re-uploading a path overwrites it, so a retry converges rather than duplicating.
4. `POST /local/v1/captures/drafts/:id/commit` writes `capture.json` and returns the same `CaptureRecord` shape the JSON endpoint returns.
5. `DELETE /local/v1/captures/drafts/:id` abandons the draft and deletes anything already uploaded.

The same limits apply as the JSON path: 5000 files and 5 GiB per capture. Path traversal is rejected; leading slashes are stripped so a path can only resolve inside the capture directory.

Set `metadata.localCaptureId` to a stable client-side id. Commit is idempotent on it: if the commit response is lost, the client cannot tell success from failure, and a retry that uploads a fresh draft would otherwise create a second durable capture and duplicate processing work. With the key present, a repeat commit returns the existing record and discards the redundant upload. Clients that omit it keep the previous behaviour, where every commit creates a new capture.

Drafts are in-memory: a draft is a transfer in progress, not durable state. A node restart mid-upload abandons the draft and the client retries, the same as any other interrupted transfer. Committed captures are durable and private exactly as before.
