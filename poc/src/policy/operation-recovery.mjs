import {
  transitionOperation
} from "./operation-journal-contract.mjs";

export const operationTableExists = (database, name) => Boolean(database.prepare(
  "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
).get(name));

export function expireOperationApproval(database, operation, observedAt) {
  if (operation.state !== "awaiting_approval" ||
      !operationTableExists(database, "approval_challenges")) {
    return;
  }
  database.prepare(`UPDATE approval_challenges SET
    status='expired', decided_at=? WHERE challenge_id=?
    AND status IN ('pending','approved')`).run(
    observedAt, operation.challenge_id
  );
  if (operationTableExists(database, "approval_leases")) {
    database.prepare(`UPDATE approval_leases SET expired_at=?
      WHERE challenge_id=? AND consumed_at IS NULL
      AND revoked_at IS NULL AND expired_at IS NULL`).run(
      observedAt, operation.challenge_id
    );
  }
}

export function recoverOperations(database, { observedAt, monotonicMs }) {
  const recovered = [];
  const operations = database.prepare(`SELECT * FROM operations
    WHERE state IN ('planned','preflighted','awaiting_approval','admitted',
      'executing') ORDER BY created_at, operation_id`).all();
  for (const operation of operations) {
    expireOperationApproval(database, operation, observedAt);
    const uncertain = operation.state === "executing";
    const state = uncertain ? "uncertain" : "abandoned";
    const certainty = uncertain ? "commit_possible" : "not_started";
    const reason = uncertain
      ? "startup_dispatch_uncertain"
      : "startup_not_dispatched";
    transitionOperation(database, {
      operationId: operation.operation_id,
      fromState: operation.state,
      toState: state,
      certainty,
      observedAt,
      monotonicMs,
      evidenceRef: "recovery://startup",
      recoveryReason: reason
    });
    recovered.push({
      operation_id: operation.operation_id,
      previous_state: operation.state,
      state,
      certainty,
      recovery_reason: reason
    });
  }
  return recovered;
}
