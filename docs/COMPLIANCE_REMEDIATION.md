# Local compliance remediation candidate

This source branch is a local release candidate. It has not been deployed.

## Durable job cancellation prerequisite

LocalStore publishes mutations only after atomic persistence succeeds. Job cancellation therefore persists its terminal decision before aborting the Node HTTP request, waits for Node-owned work to settle, and prevents late stage updates from resurrecting a cancelled job. Repeated cancellation does not add another cancellation record or counter. A failed terminal-state write leaves the operation active and reports an error so the caller can retry.

This does not stop a remote Python worker process merely by aborting HTTP. It does not establish temporary-file cleanup, IPFS removal, copyright clearance, or a production retention guarantee. Those remain separate remediation gates. Do not delete job directories until worker quiescence is established.

Tests: tests/state.test.ts and tests/spatialRuntime.test.ts exercise durable state, failure/retry, cancellation ordering and Node task settlement. Synthetic fixtures only. No live storage changes are part of this patch.

Rollback: revert the candidate commits before release. Do not roll back durable-state semantics independently of callers that rely on committed snapshots. There is no production migration in this prerequisite.
