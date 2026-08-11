# Local API (`local/v1`)

The local API shares services and one HTTP listener with the GUI, but authentication and exposure are separate. JSON responses use `{ "success": true, "data": ... }`. Except pairing bootstrap, requests require `Authorization: Bearer kubus_local_...` and the route scope.

| Method | Path | Scope |
|---|---|---|
| GET | `/local/v1/info` | `content:read` |
| GET | `/local/v1/status` | `content:read` |
| GET | `/local/v1/capabilities` | `content:read` |
| GET | `/local/v1/network` | `content:read` |
| GET | `/local/v1/storage` | `content:read` |
| GET | `/local/v1/content/:cid` | `content:read` |
| POST | `/local/v1/pairing/session` | loopback or GUI admin token |
| POST | `/local/v1/pairing/exchange` | valid one-time secret |
| POST | `/local/v1/captures` | `captures:create` |
| GET/DELETE | `/local/v1/captures/:id` | `captures:read` |
| POST/GET | `/local/v1/jobs` | `jobs:create` / `jobs:read` |
| GET | `/local/v1/jobs/:id` | `jobs:read` |
| POST | `/local/v1/jobs/:id/cancel` | `jobs:create` |
| GET | `/local/v1/spatial/:id` | `spatial:read` |
| POST | `/local/v1/spatial/:id/publish` | `spatial:publish-request` |

Pairing secrets expire after `PAIRING_SESSION_TTL_SECONDS`, are single-use, and are stored only as SHA-256 hashes. Local credentials are returned once and stored only as hashes by the node. The Flutter app stores its credential in platform secure storage.

Set `LOCAL_API_ALLOW_LAN=true` intentionally for phone pairing. Keep the admin GUI localhost-bound. The API rejects browser `Origin` requests and does not enable permissive CORS. Never put tokens in URLs or logs.
