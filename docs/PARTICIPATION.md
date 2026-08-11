# Network participation

The official kubus Node distribution implements **private compute in exchange for public infrastructure**. Useful local and remote spatial compute is available only while the runtime holds a verified archive-participation lease. Setup, status, doctor, logs, pairing and network diagnostics remain available without it.

## Gate states

- `UNCONFIGURED`: operator identity or backend policy is absent.
- `JOINING`: configuration exists but registration, pin reconciliation, scheduler or first accepted heartbeat is incomplete.
- `CONTRIBUTING`: all current policy requirements are satisfied.
- `DEGRADED`: a previously verified node has a transient failure and remains inside its lease/grace window.
- `LOCKED`: no verified lease exists or grace expired. New useful operations return HTTP 423 with `NETWORK_PARTICIPATION_REQUIRED`.

`CONTRIBUTING` requires a valid operator identity, registered node, current backend policy, healthy private Kubo RPC, public pinning enabled, configured capacity at or above `minimumContributionCapacityBytes`, a current canonical pin-set sync, healthy reconciliation, active scheduler, accepted fresh heartbeat and no production skip-pinning mode. The operator commits real capacity even when the canonical public archive is temporarily smaller; the node pins available canonical bytes rather than inventing usage.

## Lease and grace

The backend policy supplies the lease and grace duration. An accepted heartbeat renews the local lease only when the surrounding archive state is healthy enough. During a short outage, running jobs continue and diagnostics/canonical reads remain available. The official runtime does not kill GPU processes because of a momentary backend failure. When grace expires, new reconstruction, optimisation, preview generation, remote submission/acceptance and private result access lock.

The gate lives in the shared job/runtime boundary and local API result boundary. Starting only `kubus-node gui`, leaving the scheduler down, using the local API directly or reaching the private worker does not establish participation.

## Enforcement boundary

kubus Node is source available and runs on operator-owned hardware. No truthful design can cryptographically prevent a hardware owner from modifying visible source. The enforceable product rule is narrower: the unmodified official runtime, Docker stack, local API and worker require an active participation lease for useful compute. This is not DRM and the project does not claim otherwise.
