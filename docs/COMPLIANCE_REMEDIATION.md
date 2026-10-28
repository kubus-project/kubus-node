# Local compliance remediation candidate

This source branch is a local release candidate. It has not been deployed.

## Durable job cancellation prerequisite

LocalStore publishes mutations only after atomic persistence succeeds. Job cancellation therefore persists its terminal decision before aborting the Node HTTP request, waits for Node-owned work to settle, and prevents late stage updates from resurrecting a cancelled job. Repeated cancellation does not add another cancellation record or counter. A failed terminal-state write leaves the operation active and reports an error so the caller can retry.

This does not stop a remote Python worker process merely by aborting HTTP. It does not establish temporary-file cleanup, IPFS removal, copyright clearance, or a production retention guarantee. Those remain separate remediation gates. Do not delete job directories until worker quiescence is established.

Tests: tests/state.test.ts and tests/spatialRuntime.test.ts exercise durable state, failure/retry, cancellation ordering and Node task settlement. Synthetic fixtures only. No live storage changes are part of this patch.

Rollback: revert the candidate commits before release. Do not roll back durable-state semantics independently of callers that rely on committed snapshots. There is no production migration in this prerequisite.

## Journaled work-directory cleanup

New local attempts journal directory ownership before creating job files. They require worker cleanup protocol 1 and a worker instance identifier before processing. The instance is saved before HTTP submission. The worker persists cancellation tombstones and stops its process group before acknowledging quiescence. Cleanup rejects a missing, failed or mismatched acknowledgement, including a changed worker instance. Such cases retain files and a durable blocked status for operator review; a worker restart is not proof that a previous process stopped.

After success, failure or cancellation, Node attempts to remove only the journaled private/jobs/jobId directory. It preserves the original capture and Kubo outputs. Symlinks/junctions into another directory are rejected. Startup retries terminal cleanup; interrupted processing requires an explicit fresh attempt rather than silently restarting training. The authenticated POST /local/v1/jobs/cleanup route retries terminal cleanup and requires jobs:create in addition to jobs:read. Health reports cleanupPending and cleanupBlocked counts. Job cancellation now also requires jobs:create; read-only credentials cannot mutate jobs.

Existing unjournaled directories are not automatically deleted. Inventory them and approve a retention/ownership migration separately. Upgrade Node and the optional worker together; an older worker is refused for new jobs. Downgrading the worker alone cannot provide the acknowledgement required by the candidate. A changed-instance block needs evidence that the old process/container is stopped and a separately approved cleanup procedure, not a forged acknowledgement or manual change to the journal.

Verification includes synthetic filesystem failures, restart retries, missing/wrong worker receipts, preservation of captures, path/junction checks and isolated Linux process cancellation tests. Real CUDA reconstruction, deployed provider availability and remote-compute source cleanup are separate acceptance gates. Local temporary cleanup does not remove Kubo blocks, backups, independently retained copies or forensic remnants.

New processing requests are refused while a journaled cleanup is blocked. Retry cleanup or establish the missing worker/retention evidence before resuming. This gate does not constitute a review of legacy unjournaled files.

## Remote provider plaintext lifecycle

New provider records persist ownership, backend expiry, capture identity and input CID before pin/download/decryption. The local child ID is saved before a backend state transition; recovery also locates a child through its durable remote-job association. Preparation and cleanup share a completion barrier, so expiry/failure cannot delete files while decryption is still writing them. Cleanup requires child-worker quiescence before removing the owned remote-jobs directory and associated capture record. Original requester captures and generated Kubo outputs are preserved.

The local cleanup loop remains active while the provider is paused, disabled or denied backend authorization. It retries requested/expired owned records independently of backend polling. Terminal backend states and OUTPUT_READY also trigger reconciliation. Readable cleanup failures are recorded as blocked, and new assignments are declined while such a block remains. Status exposes aggregate computeCleanup counts; POST /local/v1/compute/cleanup requires compute:manage and retries requested/expired cleanup. Read-only capture credentials now also cannot invoke DELETE /local/v1/captures/:id; that operation requires captures:create.

Input pin release remains explicitly pending until reference-aware pin reconciliation is implemented and tested. No independently retained ciphertext or output copy is promised erased. Existing legacy provider records without ownership evidence are not automatically adopted for deletion. The work directory is removed only after a verified same-instance worker acknowledgement or proof that no worker attempt began. Changed-worker instances and unknown historical files remain migration/operational gates.

Tests exercise early journal failure, download/decrypt failure, local insertion and backend transition failure, active preparation, missed child-ID persistence, restart/expiry, pause/offline/authorization failure, output-ready recovery, worker refusal, junction rejection and retry after filesystem failure. These are isolated tests, not a deployed provider or real-GPU acceptance record.

## Managed pin ownership prerequisite

ManagedPins records opaque owners before a pin operation and journals owner release before attempting an unpin. Equivalent CIDv0/CIDv1 identifiers share one key. Other archive, spatial and legacy private-input references protect a CID. Pins already present before adoption, and pins whose prior ownership cannot be determined, are retained rather than automatically removed. Failed releases remain pending across a restart. A generic missing RPC route is not treated as proof that a pin is absent. This module is a prerequisite: archive and compute flows have not yet been migrated to it, and this commit does not activate automatic stale-pin removal.

Official CLI writers now claim an exclusive lease beside the state file before initializing identity, credentials or mutable runtime state. A second writer is refused. The status and doctor commands read a snapshot without creating keys, directories or repairing a corrupt file; they remain available while the daemon holds the lease. Read-only stores reject updates. Short maintenance commands release their own lease when finished. Long-running commands retain it until a subsequent process can establish that the owner stopped, because deadline-limited shutdown can leave work in flight.

The lease uses a local filesystem atomic hard-link operation and host/process identity checks. It is not a distributed lock. Another host, an unobservable PID namespace, a malformed ownership file or an interrupted stale-owner recovery requires operator review. A replacement container can have a different PID namespace even on the same machine. Before release, document and test recovery after proving the former writer and all its workers stopped; never delete a live lease merely to bypass refusal. Existing older binaries and external code do not honor the new lease and must not write the same state concurrently. Hard-link support on the actual state volume is an activation requirement. No production state or lease has been changed.

Regression coverage includes a real synthetic child process, refusal while it is alive and recovery after its exit; same-process contention; unknown/malformed ownership; both diagnostic commands while a writer is active; failed journal writes; shared CID owners; withdrawal; restart retries; legacy-reference protection; and invalid CID rejection. Roll back this prerequisite only before dependent pin-flow changes, with the runtime stopped and state preserved. An already created ownership ledger is not evidence that legacy pins may be deleted.

## HTTP pin fallback integrity

The public archive HTTP fallback now imports returned bytes with pin=false, compares parsed canonical CIDs (including equivalent v0/v1 forms), and pins only after a match. A failed final pin is reported as failure rather than successful availability. Invalid requested identifiers are rejected before Kubo or gateway access. Existing addBytes callers retain their previous default unless they explicitly request an unpinned import. A mismatched gateway response may leave unpinned Kubo blocks; this correction does not perform garbage collection or promise forensic erasure. Existing pins are unchanged. This is one integrity boundary, not the complete spatial-manifest or managed-pin reconciliation fix.

The opt-in tests/managedPins.kubo.test.ts suite checks an explicitly identified disposable loopback Kubo peer before any writes. It exercises real unpinned imports, shared owners, failed-release persistence/restart, protection of manually pinned content, and both matching and mismatched HTTP fallback bytes. On 28 October 2026 it passed against an isolated offline Kubo 0.43.0 container with synthetic bytes; the owned container was stopped afterward. The regular suite skips this integration test unless both KUBUS_TEST_DISPOSABLE_KUBO_RPC and KUBUS_TEST_DISPOSABLE_KUBO_PEER identify such a fixture. Do not run it against an existing operator repository. No production pin, content or network was tested or changed. The standard smoke script still needs an isolated configured backend fixture; a missing local NODE_ENV prevents its execution, which is not a smoke pass.
