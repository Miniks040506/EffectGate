import { createHash } from "node:crypto";

import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";

export const OPERATION_PATTERNS = Object.freeze({
  digest: /^sha256:[a-f0-9]{64}$/u,
  identifier: /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u,
  challenge: /^chal_[A-Za-z0-9_-]{24}$/u
});
export const OPERATION_STATES = Object.freeze([
  "planned", "preflighted", "awaiting_approval", "admitted", "executing",
  "abandoned", "uncertain"
]);
export const OPERATION_CERTAINTIES = Object.freeze([
  "not_started", "started_no_commit_evidence", "commit_possible",
  "backend_claimed_committed", "verified_committed",
  "verified_not_committed"
]);

const TRANSITIONS = Object.freeze({
  planned: new Set(["preflighted", "abandoned"]),
  preflighted: new Set(["awaiting_approval", "admitted", "abandoned"]),
  awaiting_approval: new Set(["admitted", "abandoned"]),
  admitted: new Set(["executing", "abandoned"]),
  executing: new Set(["uncertain"]),
  abandoned: new Set(),
  uncertain: new Set()
});

export const OPERATION_SCHEMA = `
PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS operation_clock (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), max_wall_ms INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO operation_clock VALUES (1, 0);
CREATE TABLE IF NOT EXISTS operations (
  operation_id TEXT PRIMARY KEY, intent_digest TEXT NOT NULL,
  principal_id TEXT NOT NULL, client_id TEXT NOT NULL, session_id TEXT NOT NULL,
  transaction_id TEXT NOT NULL, skill_id TEXT NOT NULL, skill_digest TEXT NOT NULL,
  phase TEXT NOT NULL, phase_revision INTEGER NOT NULL,
  capsule_digest TEXT NOT NULL, capability_id TEXT NOT NULL,
  capability_revision TEXT NOT NULL, effect_class TEXT NOT NULL,
  canonical_arguments_hash TEXT NOT NULL, disclosure_digest TEXT NOT NULL,
  policy_revision TEXT NOT NULL, resource_scope_json TEXT NOT NULL,
  intent_expires_at TEXT NOT NULL,
  approval_required INTEGER NOT NULL CHECK(approval_required IN (0,1)),
  challenge_id TEXT, approval_proof_digest TEXT, state TEXT NOT NULL
    CHECK(state IN ('planned','preflighted','awaiting_approval','admitted',
      'executing','abandoned','uncertain')),
  certainty TEXT NOT NULL CHECK(certainty IN ('not_started',
    'started_no_commit_evidence','commit_possible','backend_claimed_committed',
    'verified_committed','verified_not_committed')),
  dispatch_digest TEXT, deadline_at TEXT, recovery_reason TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  last_event_digest TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS operation_events (
  operation_id TEXT NOT NULL, sequence INTEGER NOT NULL,
  previous_state TEXT, new_state TEXT NOT NULL, certainty TEXT NOT NULL,
  observed_at TEXT NOT NULL, monotonic_ms REAL NOT NULL,
  capability_revision TEXT NOT NULL, policy_revision TEXT NOT NULL,
  evidence_ref TEXT, previous_event_digest TEXT, event_digest TEXT NOT NULL UNIQUE,
  PRIMARY KEY(operation_id, sequence),
  FOREIGN KEY(operation_id) REFERENCES operations(operation_id),
  CHECK((sequence=1 AND previous_state IS NULL) OR
    (sequence>1 AND previous_state IS NOT NULL))
) STRICT;
CREATE INDEX IF NOT EXISTS operations_recovery ON operations(state, updated_at);
CREATE INDEX IF NOT EXISTS operations_session ON operations(session_id, state);
CREATE TRIGGER IF NOT EXISTS operation_events_no_update
BEFORE UPDATE ON operation_events BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER IF NOT EXISTS operation_events_no_delete
BEFORE DELETE ON operation_events BEGIN SELECT RAISE(ABORT, 'immutable'); END;
PRAGMA user_version=3;
`;

export class OperationJournalError extends Error {
  constructor(code = "EG_OPERATION_NOT_ADMISSIBLE") {
    super("operation transition is not admissible");
    this.name = "OperationJournalError";
    this.code = code;
  }
}

export function operationFail(code) {
  throw new OperationJournalError(code);
}

export function boundedOperationValue(value, maximum = 128, pattern) {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= maximum && Buffer.byteLength(value, "utf8") <= maximum * 4 &&
    !value.includes("\0") && value === value.normalize("NFC") &&
    (!pattern || pattern.test(value));
}

export function operationEventDigest(event) {
  return `sha256:${createHash("sha256")
    .update("effectgate.operation-event.v1\0")
    .update(canonicalJson(event))
    .digest("hex")}`;
}

export const operationTransitionAllowed = (fromState, toState) =>
  Boolean(TRANSITIONS[fromState]?.has(toState));

export const operationCertaintyAllowed = (state, certainty) =>
  state === "uncertain"
    ? ["started_no_commit_evidence", "commit_possible",
      "backend_claimed_committed"].includes(certainty)
    : certainty === "not_started";

function canonicalTimestamp(value) {
  try {
    return typeof value === "string" &&
      new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

export function transitionOperation(database, input = {}) {
  const {
    operationId, fromState, toState, certainty, observedAt, monotonicMs,
    evidenceRef = null, challengeId = null, approvalProofDigest = null,
    dispatchDigest = null, deadlineAt = null, recoveryReason = null
  } = input;
  if (!boundedOperationValue(
    operationId, 128, OPERATION_PATTERNS.identifier
  ) ||
      !operationTransitionAllowed(fromState, toState) ||
      !OPERATION_CERTAINTIES.includes(certainty) ||
      !canonicalTimestamp(observedAt) ||
      !Number.isFinite(monotonicMs) || monotonicMs < 0 ||
      (evidenceRef !== null &&
        !boundedOperationValue(evidenceRef, 1024)) ||
      (challengeId !== null &&
        !OPERATION_PATTERNS.challenge.test(challengeId)) ||
      [approvalProofDigest, dispatchDigest].some((value) =>
        value !== null && !OPERATION_PATTERNS.digest.test(value)) ||
      (deadlineAt !== null && !canonicalTimestamp(deadlineAt)) ||
      (recoveryReason !== null &&
        !boundedOperationValue(recoveryReason, 128))) {
    operationFail("EG_OPERATION_TRANSITION_DENIED");
  }
  if (!operationCertaintyAllowed(toState, certainty)) {
    operationFail("EG_OPERATION_CERTAINTY_INVALID");
  }
  const operation = database.prepare(
    "SELECT * FROM operations WHERE operation_id=?"
  ).get(operationId);
  if (!operation) operationFail("EG_OPERATION_NOT_FOUND");
  if (operation.state !== fromState) {
    operationFail("EG_OPERATION_TRANSITION_DENIED");
  }
  const latest = database.prepare(`SELECT sequence FROM operation_events
    WHERE operation_id=? ORDER BY sequence DESC LIMIT 1`).get(operationId);
  const event = {
    operation_id: operationId,
    sequence: (latest?.sequence ?? 0) + 1,
    previous_state: fromState,
    new_state: toState,
    certainty,
    observed_at: observedAt,
    monotonic_ms: monotonicMs,
    capability_revision: operation.capability_revision,
    policy_revision: operation.policy_revision,
    evidence_ref: evidenceRef,
    previous_event_digest: operation.last_event_digest
  };
  const eventDigest = operationEventDigest(event);
  const changed = database.prepare(`UPDATE operations SET state=?, certainty=?,
    updated_at=?, last_event_digest=?, challenge_id=COALESCE(?,challenge_id),
    approval_proof_digest=COALESCE(?,approval_proof_digest),
    dispatch_digest=COALESCE(?,dispatch_digest),
    deadline_at=COALESCE(?,deadline_at),
    recovery_reason=COALESCE(?,recovery_reason)
    WHERE operation_id=? AND state=?`).run(
    toState, certainty, observedAt, eventDigest, challengeId,
    approvalProofDigest, dispatchDigest, deadlineAt, recoveryReason,
    operationId, fromState
  ).changes;
  if (changed !== 1) operationFail("EG_OPERATION_TRANSITION_DENIED");
  database.prepare(`INSERT INTO operation_events
    (operation_id, sequence, previous_state, new_state, certainty, observed_at,
     monotonic_ms, capability_revision, policy_revision, evidence_ref,
     previous_event_digest, event_digest)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    operationId, event.sequence, fromState, toState, certainty, observedAt,
    monotonicMs, operation.capability_revision, operation.policy_revision,
    evidenceRef, operation.last_event_digest, eventDigest
  );
  return deepFreeze({ ...event, event_digest: eventDigest });
}

export function loadOperation(database, operationId) {
  if (!boundedOperationValue(
    operationId, 128, OPERATION_PATTERNS.identifier
  )) {
    throw new TypeError("invalid operation ID");
  }
  const row = database.prepare(
    "SELECT * FROM operations WHERE operation_id=?"
  ).get(operationId);
  if (!row) return undefined;
  const events = database.prepare(`SELECT * FROM operation_events
    WHERE operation_id=? ORDER BY sequence`).all(operationId);
  let previousDigest = null;
  let previousState = null;
  for (const [index, event] of events.entries()) {
    const { event_digest: claimed, ...body } = event;
    if (event.sequence !== index + 1 ||
        event.previous_state !== previousState ||
        event.previous_event_digest !== previousDigest ||
        event.capability_revision !== row.capability_revision ||
        event.policy_revision !== row.policy_revision ||
        (index === 0
          ? event.new_state !== "planned" ||
            event.certainty !== "not_started"
          : !operationTransitionAllowed(
            event.previous_state, event.new_state
          ) ||
            !operationCertaintyAllowed(
              event.new_state, event.certainty
            )) ||
        operationEventDigest(body) !== claimed) {
      operationFail("EG_OPERATION_CORRUPT");
    }
    previousState = event.new_state;
    previousDigest = claimed;
  }
  const last = events.at(-1);
  if (!last || row.state !== last.new_state ||
      row.certainty !== last.certainty ||
      row.last_event_digest !== last.event_digest ||
      (row.state === "awaiting_approval" && !row.challenge_id) ||
      (["executing", "uncertain"].includes(row.state) &&
        (!row.dispatch_digest || !row.deadline_at))) {
    operationFail("EG_OPERATION_CORRUPT");
  }
  let resourceScope;
  try {
    resourceScope = JSON.parse(row.resource_scope_json);
  } catch {
    operationFail("EG_OPERATION_CORRUPT");
  }
  if (canonicalJson(resourceScope) !== row.resource_scope_json) {
    operationFail("EG_OPERATION_CORRUPT");
  }
  const { resource_scope_json: ignored, approval_required: required,
    ...operation } = row;
  return deepFreeze({
    operation: {
      schema_version: "1.0.0",
      ...operation,
      resource_scope: resourceScope,
      approval_required: required === 1
    },
    events
  });
}
