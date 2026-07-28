import { createHash } from "node:crypto";

import {
  OPERATION_PATTERNS,
  boundedOperationValue,
  operationFail
} from "./operation-journal-contract.mjs";
import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";

const CLASSIFICATIONS = new Set([
  "committed", "not_committed", "ambiguous"
]);
const OUTCOMES = new Set([
  "verified_committed", "verified_not_committed", "manual_resolution"
]);
const RECONCILIATION_STATES = new Set([
  "reconciling", ...OUTCOMES
]);

export const RECONCILIATION_SCHEMA = `
CREATE TABLE IF NOT EXISTS operation_reconciliations (
  operation_id TEXT PRIMARY KEY, descriptor_digest TEXT NOT NULL,
  started_at TEXT NOT NULL, deadline_at TEXT NOT NULL,
  max_attempts INTEGER NOT NULL CHECK(max_attempts BETWEEN 1 AND 10),
  FOREIGN KEY(operation_id) REFERENCES operations(operation_id)
) STRICT;
CREATE TABLE IF NOT EXISTS operation_verification_attempts (
  operation_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt > 0),
  classification TEXT NOT NULL CHECK(classification IN
    ('committed','not_committed','ambiguous')),
  evidence_ref TEXT, evidence_digest TEXT, result_digest TEXT,
  safe_reason_code TEXT NOT NULL, observed_at TEXT NOT NULL,
  attempt_digest TEXT NOT NULL UNIQUE,
  PRIMARY KEY(operation_id, attempt),
  FOREIGN KEY(operation_id) REFERENCES operation_reconciliations(operation_id),
  CHECK((evidence_ref IS NULL AND evidence_digest IS NULL AND
    result_digest IS NULL) OR (evidence_ref IS NOT NULL AND
    evidence_digest IS NOT NULL AND result_digest IS NOT NULL))
) STRICT;
CREATE TABLE IF NOT EXISTS operation_reconciliation_outcomes (
  operation_id TEXT PRIMARY KEY, outcome TEXT NOT NULL CHECK(outcome IN
    ('verified_committed','verified_not_committed','manual_resolution')),
  run_evidence_digest TEXT NOT NULL, finalized_at TEXT NOT NULL,
  outcome_digest TEXT NOT NULL UNIQUE,
  FOREIGN KEY(operation_id) REFERENCES operation_reconciliations(operation_id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS operation_reconciliations_no_update
BEFORE UPDATE ON operation_reconciliations
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER IF NOT EXISTS operation_reconciliations_no_delete
BEFORE DELETE ON operation_reconciliations
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER IF NOT EXISTS operation_verification_attempts_no_update
BEFORE UPDATE ON operation_verification_attempts
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER IF NOT EXISTS operation_verification_attempts_no_delete
BEFORE DELETE ON operation_verification_attempts
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER IF NOT EXISTS operation_reconciliation_outcomes_no_update
BEFORE UPDATE ON operation_reconciliation_outcomes
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER IF NOT EXISTS operation_reconciliation_outcomes_no_delete
BEFORE DELETE ON operation_reconciliation_outcomes
BEGIN SELECT RAISE(ABORT, 'immutable'); END;
PRAGMA user_version=5;
`;

function exactObject(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
    });
}

function timestamp(value) {
  try {
    return typeof value === "string" &&
      new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function digest(domain, value) {
  return `sha256:${createHash("sha256")
    .update(`${domain}\0`)
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function attemptBody(operationId, record, observedAt) {
  if (!exactObject(record, [
    "attempt", "classification", "evidence_ref", "evidence_digest",
    "result_digest", "safe_reason_code"
  ]) ||
      !OPERATION_PATTERNS.identifier.test(operationId ?? "") ||
      !Number.isSafeInteger(record.attempt) || record.attempt < 1 ||
      !CLASSIFICATIONS.has(record.classification) ||
      !boundedOperationValue(record.safe_reason_code, 128) ||
      !timestamp(observedAt)) {
    operationFail("EG_RECONCILIATION_ATTEMPT_INVALID");
  }
  const emptyEvidence = record.evidence_ref === null &&
    record.evidence_digest === null && record.result_digest === null;
  const boundedEvidence = boundedOperationValue(record.evidence_ref, 1024) &&
    OPERATION_PATTERNS.digest.test(record.evidence_digest ?? "") &&
    OPERATION_PATTERNS.digest.test(record.result_digest ?? "");
  if (!emptyEvidence && !boundedEvidence) {
    operationFail("EG_RECONCILIATION_ATTEMPT_INVALID");
  }
  return {
    operation_id: operationId,
    attempt: record.attempt,
    classification: record.classification,
    evidence_ref: record.evidence_ref,
    evidence_digest: record.evidence_digest,
    result_digest: record.result_digest,
    safe_reason_code: record.safe_reason_code,
    observed_at: observedAt
  };
}

export function reconciliationAttemptRecord({
  operationId, record, observedAt
} = {}) {
  const body = attemptBody(operationId, record, observedAt);
  return deepFreeze({
    ...body,
    attempt_digest: digest("effectgate.reconciliation-attempt.v1", body)
  });
}

export function reconciliationRunEvidenceDigest({
  operationId, descriptorDigest, attempts, reason
} = {}) {
  if (!OPERATION_PATTERNS.identifier.test(operationId ?? "") ||
      !OPERATION_PATTERNS.digest.test(descriptorDigest ?? "") ||
      !Array.isArray(attempts) ||
      attempts.some(({ attempt_digest: value }) =>
        !OPERATION_PATTERNS.digest.test(value ?? "")) ||
      !boundedOperationValue(reason, 128)) {
    operationFail("EG_RECONCILIATION_OUTCOME_INVALID");
  }
  return digest("effectgate.reconciliation-run.v1", {
    operation_id: operationId,
    descriptor_digest: descriptorDigest,
    attempt_digests: attempts.map(({ attempt_digest: value }) => value),
    reason
  });
}

export function reconciliationOutcomeRecord({
  operationId, descriptorDigest, outcome, runEvidenceDigest, finalizedAt,
  attempts
} = {}) {
  if (!OPERATION_PATTERNS.identifier.test(operationId ?? "") ||
      !OPERATION_PATTERNS.digest.test(descriptorDigest ?? "") ||
      !OUTCOMES.has(outcome) ||
      !OPERATION_PATTERNS.digest.test(runEvidenceDigest ?? "") ||
      !timestamp(finalizedAt) || !Array.isArray(attempts) ||
      attempts.some(({ attempt_digest: value }) =>
        !OPERATION_PATTERNS.digest.test(value ?? ""))) {
    operationFail("EG_RECONCILIATION_OUTCOME_INVALID");
  }
  const body = {
    operation_id: operationId,
    descriptor_digest: descriptorDigest,
    outcome,
    run_evidence_digest: runEvidenceDigest,
    finalized_at: finalizedAt,
    attempt_digests: attempts.map(({ attempt_digest: value }) => value)
  };
  return deepFreeze({
    operation_id: operationId,
    outcome,
    run_evidence_digest: runEvidenceDigest,
    finalized_at: finalizedAt,
    outcome_digest: digest("effectgate.reconciliation-outcome.v1", body)
  });
}

function tablesPresent(database) {
  return [
    "operation_reconciliations",
    "operation_verification_attempts",
    "operation_reconciliation_outcomes"
  ].map((name) => Boolean(database.prepare(
    "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?"
  ).get(name)));
}

export function loadOperationReconciliation(database, loaded) {
  const present = tablesPresent(database);
  if (!present.every(Boolean)) {
    if (present.some(Boolean) ||
        RECONCILIATION_STATES.has(loaded.operation.state)) {
      operationFail("EG_OPERATION_CORRUPT");
    }
    return deepFreeze({
      ...loaded,
      operation: { ...loaded.operation, reconciliation: null }
    });
  }
  const operationId = loaded.operation.operation_id;
  const start = database.prepare(`SELECT * FROM operation_reconciliations
    WHERE operation_id=?`).get(operationId);
  const attempts = database.prepare(`SELECT *
    FROM operation_verification_attempts WHERE operation_id=?
    ORDER BY attempt`).all(operationId);
  const outcome = database.prepare(`SELECT *
    FROM operation_reconciliation_outcomes WHERE operation_id=?`
  ).get(operationId);
  if (!start) {
    const last = loaded.events.at(-1);
    const directManual = loaded.operation.state === "manual_resolution" &&
      last?.previous_state === "uncertain" &&
      OPERATION_PATTERNS.digest.test(last.evidence_ref ?? "");
    if (attempts.length > 0 || outcome ||
        (RECONCILIATION_STATES.has(loaded.operation.state) && !directManual)) {
      operationFail("EG_OPERATION_CORRUPT");
    }
    return deepFreeze({
      ...loaded,
      operation: { ...loaded.operation, reconciliation: null }
    });
  }
  if (start.operation_id !== operationId ||
      !OPERATION_PATTERNS.digest.test(start.descriptor_digest ?? "") ||
      !timestamp(start.started_at) || !timestamp(start.deadline_at) ||
      Date.parse(start.deadline_at) <= Date.parse(start.started_at) ||
      !Number.isSafeInteger(start.max_attempts) ||
      start.max_attempts < 1 || start.max_attempts > 10 ||
      attempts.length > start.max_attempts ||
      !RECONCILIATION_STATES.has(loaded.operation.state)) {
    operationFail("EG_OPERATION_CORRUPT");
  }
  for (const [index, attempt] of attempts.entries()) {
    const { attempt_digest: claimed, ...body } = attempt;
    let expected;
    try {
      expected = reconciliationAttemptRecord({
        operationId,
        record: {
          attempt: body.attempt,
          classification: body.classification,
          evidence_ref: body.evidence_ref,
          evidence_digest: body.evidence_digest,
          result_digest: body.result_digest,
          safe_reason_code: body.safe_reason_code
        },
        observedAt: body.observed_at
      });
    } catch {
      operationFail("EG_OPERATION_CORRUPT");
    }
    if (attempt.attempt !== index + 1 ||
        expected.attempt_digest !== claimed) {
      operationFail("EG_OPERATION_CORRUPT");
    }
  }
  const reconcileEvent = loaded.events.find(
    ({ new_state: state }) => state === "reconciling"
  );
  if (!reconcileEvent ||
      reconcileEvent.evidence_ref !== start.descriptor_digest) {
    operationFail("EG_OPERATION_CORRUPT");
  }
  let verifiedOutcome = null;
  if (outcome) {
    let expected;
    try {
      expected = reconciliationOutcomeRecord({
        operationId,
        descriptorDigest: start.descriptor_digest,
        outcome: outcome.outcome,
        runEvidenceDigest: outcome.run_evidence_digest,
        finalizedAt: outcome.finalized_at,
        attempts
      });
    } catch {
      operationFail("EG_OPERATION_CORRUPT");
    }
    if (canonicalJson(expected) !== canonicalJson(outcome) ||
        outcome.outcome !== loaded.operation.state ||
        loaded.events.at(-1)?.evidence_ref !== outcome.outcome_digest) {
      operationFail("EG_OPERATION_CORRUPT");
    }
    verifiedOutcome = { schema_version: "1.0.0", ...outcome };
  } else if (loaded.operation.state !== "reconciling" ||
      loaded.events.at(-1)?.new_state !== "reconciling") {
    operationFail("EG_OPERATION_CORRUPT");
  }
  return deepFreeze({
    ...loaded,
    operation: {
      ...loaded.operation,
      reconciliation: {
        schema_version: "1.0.0",
        ...start,
        attempts: attempts.map((attempt) => ({
          schema_version: "1.0.0",
          ...attempt
        })),
        outcome: verifiedOutcome
      }
    }
  });
}
