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
