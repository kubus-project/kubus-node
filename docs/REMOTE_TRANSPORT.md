# Remote paired-device transport

kubus Node exposes the same `/local/v1` dispatcher through a local HTTP route
and through one reliable, ordered WebRTC data channel. The two adapters do not
have separate authorization or mutation logic.

## Connection flow

1. The Node registers and then connects to the backend's `/node-signaling`
   Socket.IO namespace with its scoped operator token and durable node id.
2. A signed-in paired app asks the namespace for a short-lived session.
3. The Node accepts the session, receives the app's SDP offer and bounded ICE
   candidates, and returns its answer/candidates. SDP, candidates, and TURN
   credentials are never written to Node logs.
4. The Node answers an Ed25519 challenge on the data channel. The app compares
   its signature against the public key saved at pairing; a fingerprint in
   signaling presence is only advisory.
5. Only after that proof does the app send its local Node credential or a
   `/local/v1` request.

The signaling service carries coordination only. Capture bytes, results, and
the local Node credential never cross it. If it is unavailable, the Node keeps
its archive work and direct local/HTTPS routes alive; only remote WebRTC
coordination is unavailable.

## ICE and relay

The app gets a short-lived coturn REST credential from `/api/turn/credentials`
and includes it in its authenticated signaling offer so the Node can allocate
its end of the same relay. The static coturn secret is not delivered to either
app or Node. A missing or expired TURN credential removes the relay candidate;
direct ICE is still attempted.

Inbound session, candidate, message, frame, and request-body limits are all
bounded. Sessions expire at the backend and are closed locally on expiry,
disconnect, failed ICE, or Node shutdown. A reconnect re-announces presence;
pairing credentials and the Node's identity stay in durable storage.
