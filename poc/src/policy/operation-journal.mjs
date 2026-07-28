import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import {
  OPERATION_PATTERNS,
  OPERATION_SCHEMA,
  OperationJournalError,
  boundedOperationValue,
  loadOperation,
  operationDispatchEvidenceDigest,
  operationEventDigest,
  operationFail,
  transitionOperation
} from "./operation-journal-contract.mjs";
import { verifyEffectIntent } from "./effect-intent.mjs";
import {
  IDEMPOTENCY_SCHEMA,
  IdempotencyAdapterError,
  idempotencyMetadata
} from "./idempotency-adapter.mjs";
import {
  expireOperationApproval,
  operationTableExists,
  recoverOperations
} from "./operation-recovery.mjs";
import {
  RECONCILIATION_SCHEMA,
  loadOperationReconciliation,
  reconciliationAttemptRecord,
  reconciliationOutcomeRecord,
  reconciliationRunEvidenceDigest
} from "./operation-reconciliation.mjs";
import {
  runVerificationProbe,
  verifyVerificationProbe
} from "./verification-probe.mjs";
import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";

export { OperationJournalError };

const timestamp = (milliseconds) => new Date(milliseconds).toISOString();

export class EffectOperationJournal {
  #database;
  #lastMonotonic = 0;
  #monotonic;
  #now;

  constructor({ file, now = Date.now,
    monotonic = () => performance.now() } = {}) {
    if (!boundedOperationValue(file, 1024) ||
        typeof now !== "function" || typeof monotonic !== "function") {
      throw new TypeError("invalid operation journal configuration");
    }
    const databaseFile = resolve(file);
    mkdirSync(dirname(databaseFile), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(databaseFile);
    this.#database.exec(OPERATION_SCHEMA);
    this.#database.exec(IDEMPOTENCY_SCHEMA);
    this.#database.exec(RECONCILIATION_SCHEMA);
    this.#now = now;
    this.#monotonic = monotonic;
  }

  plan({ operationId, intent, approvalRequired } = {}) {
    verifyEffectIntent(intent);
    if (!boundedOperationValue(
      operationId, 128, OPERATION_PATTERNS.identifier
    ) || typeof approvalRequired !== "boolean") {
      throw new TypeError("invalid operation plan");
    }
    const clock = this.#begin();
    try {
      if (Date.parse(intent.expires_at) <= clock.wall) {
        operationFail("EG_OPERATION_INTENT_EXPIRED");
      }
      if (this.#database.prepare(
        "SELECT 1 FROM operations WHERE operation_id=?"
      ).get(operationId)) {
        operationFail("EG_OPERATION_ALREADY_EXISTS");
      }
      if (this.#database.prepare(
        "SELECT 1 FROM operations WHERE intent_digest=?"
      ).get(intent.intent_digest)) {
        operationFail("EG_OPERATION_INTENT_REUSE");
      }
      const observedAt = timestamp(clock.wall);
      const event = {
        operation_id: operationId,
        sequence: 1,
        previous_state: null,
        new_state: "planned",
        certainty: "not_started",
        observed_at: observedAt,
        monotonic_ms: clock.monotonic,
        capability_revision: intent.capability_revision,
        policy_revision: intent.policy_revision,
        evidence_ref: null,
        previous_event_digest: null
      };
      const eventDigest = operationEventDigest(event);
      this.#database.prepare(`INSERT INTO operations
        (operation_id, intent_digest, principal_id, client_id, session_id,
         transaction_id, skill_id, skill_digest, phase, phase_revision,
         capsule_digest, capability_id, capability_revision, effect_class,
         canonical_arguments_hash, disclosure_digest, policy_revision,
         resource_scope_json, intent_expires_at, approval_required, state,
         certainty, created_at, updated_at, last_event_digest)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
          'planned', 'not_started', ?, ?, ?)`).run(
        operationId, intent.intent_digest, intent.principal_id, intent.client_id,
        intent.session_id, intent.transaction_id, intent.skill_id,
        intent.skill_digest, intent.phase, intent.phase_revision,
        intent.capsule_digest, intent.capability_id, intent.capability_revision,
        intent.effect_class, intent.canonical_arguments_hash,
        intent.disclosure_digest, intent.policy_revision,
        canonicalJson(intent.resource_scope), intent.expires_at,
        approvalRequired ? 1 : 0, observedAt, observedAt, eventDigest
      );
      this.#database.prepare(`INSERT INTO operation_events
        (operation_id, sequence, previous_state, new_state, certainty,
         observed_at, monotonic_ms, capability_revision, policy_revision,
         evidence_ref, previous_event_digest, event_digest)
        VALUES (?, 1, NULL, 'planned', 'not_started', ?, ?, ?, ?, NULL,
          NULL, ?)`).run(
        operationId, observedAt, clock.monotonic, intent.capability_revision,
        intent.policy_revision, eventDigest
      );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
    return this.load(operationId).operation;
  }

  preflight(operationId) {
    return this.#change({
      operationId,
      fromState: "planned",
      toState: "preflighted"
    });
  }

  awaitApproval({ operationId, challengeId } = {}) {
    if (!OPERATION_PATTERNS.challenge.test(challengeId ?? "")) {
      throw new TypeError("invalid approval challenge binding");
    }
    const clock = this.#begin();
    try {
      const operation = this.#database.prepare(
        "SELECT * FROM operations WHERE operation_id=?"
      ).get(operationId);
      const challenge = operationTableExists(
        this.#database, "approval_challenges"
      )
        ? this.#database.prepare(`SELECT * FROM approval_challenges
          WHERE challenge_id=?`).get(challengeId)
        : undefined;
      if (!operation || operation.approval_required !== 1 ||
          operation.state !== "preflighted" || !challenge ||
          challenge.status !== "pending" ||
          Date.parse(challenge.expires_at) <= clock.wall ||
          challenge.intent_digest !== operation.intent_digest ||
          challenge.session_id !== operation.session_id) {
        operationFail("EG_OPERATION_APPROVAL_INVALID");
      }
      transitionOperation(this.#database, {
        operationId,
        fromState: "preflighted",
        toState: "awaiting_approval",
        certainty: "not_started",
        observedAt: timestamp(clock.wall),
        monotonicMs: clock.monotonic,
        challengeId
      });
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
    return this.load(operationId).operation;
  }

  admit(operationId) {
    const operation = this.#database.prepare(
      "SELECT approval_required FROM operations WHERE operation_id=?"
    ).get(operationId);
    if (!operation || operation.approval_required !== 0) {
      operationFail("EG_OPERATION_APPROVAL_REQUIRED");
    }
    return this.#change({
      operationId,
      fromState: "preflighted",
      toState: "admitted"
    });
  }

  beginDispatch({
    operationId, dispatchDigest, deadlineAt, idempotency = null
  } = {}) {
    let deadline;
    try {
      deadline = new Date(deadlineAt).toISOString();
    } catch {
      throw new TypeError("invalid operation deadline");
    }
    if (!OPERATION_PATTERNS.digest.test(dispatchDigest ?? "") ||
        deadline !== deadlineAt) {
      throw new TypeError("invalid dispatch intent");
    }
    const clock = this.#begin();
    try {
      if (Date.parse(deadline) <= clock.wall) {
        operationFail("EG_OPERATION_DEADLINE_EXPIRED");
      }
      let dispatchEvidence = dispatchDigest;
      if (idempotency !== null) {
        if (idempotency?.dispatch_digest !== dispatchDigest) {
          throw new IdempotencyAdapterError(
            "EG_IDEMPOTENCY_DISPATCH_MISMATCH"
          );
        }
        const operation = this.#database.prepare(
          "SELECT * FROM operations WHERE operation_id=?"
        ).get(operationId);
        const metadata = idempotencyMetadata({
          ...idempotency,
          operation: { schema_version: "1.0.0", ...operation }
        });
        if (this.#database.prepare(`SELECT 1 FROM operation_idempotency
          WHERE key_hash=?`).get(metadata.key_hash)) {
          throw new IdempotencyAdapterError("EG_IDEMPOTENCY_KEY_REUSE");
        }
        const createdAt = timestamp(clock.wall);
        this.#database.prepare(`INSERT INTO operation_idempotency
          (operation_id, intent_digest, adapter_digest, key_hash, key_target,
           key_name, lookup_capability_id, lookup_capability_revision,
           created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          operationId, metadata.intent_digest, metadata.adapter_digest,
          metadata.key_hash, metadata.key_target, metadata.key_name,
          metadata.lookup_capability_id,
          metadata.lookup_capability_revision, createdAt
        );
        dispatchEvidence = operationDispatchEvidenceDigest(
          dispatchDigest,
          { ...metadata, created_at: createdAt }
        );
      }
      transitionOperation(this.#database, {
        operationId,
        fromState: "admitted",
        toState: "executing",
        certainty: "not_started",
        observedAt: timestamp(clock.wall),
        monotonicMs: clock.monotonic,
        evidenceRef: dispatchEvidence,
        dispatchDigest,
        deadlineAt: deadline
      });
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
    return this.load(operationId).operation;
  }

  cancel(operationId) {
    const clock = this.#begin();
    try {
      const operation = this.#database.prepare(
        "SELECT * FROM operations WHERE operation_id=?"
      ).get(operationId);
      if (!operation ||
          !["planned", "preflighted", "awaiting_approval", "admitted",
            "executing"].includes(operation.state)) {
        operationFail("EG_OPERATION_TRANSITION_DENIED");
      }
      expireOperationApproval(
        this.#database, operation, timestamp(clock.wall)
      );
      const uncertain = operation.state === "executing";
      transitionOperation(this.#database, {
        operationId,
        fromState: operation.state,
        toState: uncertain ? "uncertain" : "abandoned",
        certainty: uncertain ? "commit_possible" : "not_started",
        observedAt: timestamp(clock.wall),
        monotonicMs: clock.monotonic,
        evidenceRef: "cancel://request",
        recoveryReason: uncertain
          ? "canceled_after_dispatch"
          : "canceled_before_dispatch"
      });
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
    return this.load(operationId).operation;
  }

  markUncertain({
    operationId, certainty = "commit_possible", evidenceRef, reason
  } = {}) {
    if (!boundedOperationValue(evidenceRef, 1024) ||
        !boundedOperationValue(reason, 128)) {
      operationFail("EG_OPERATION_UNCERTAINTY_INVALID");
    }
    const clock = this.#begin();
    try {
      transitionOperation(this.#database, {
        operationId,
        fromState: "executing",
        toState: "uncertain",
        certainty,
        observedAt: timestamp(clock.wall),
        monotonicMs: clock.monotonic,
        evidenceRef,
        recoveryReason: reason
      });
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
    return this.load(operationId).operation;
  }

  requireManualResolution({ operationId, evidenceDigest } = {}) {
    if (!OPERATION_PATTERNS.digest.test(evidenceDigest ?? "")) {
      operationFail("EG_RECONCILIATION_EVIDENCE_INVALID");
    }
    const clock = this.#begin();
    try {
      const operation = this.#database.prepare(
        "SELECT certainty FROM operations WHERE operation_id=?"
      ).get(operationId);
      transitionOperation(this.#database, {
        operationId,
        fromState: "uncertain",
        toState: "manual_resolution",
        certainty: operation?.certainty,
        observedAt: timestamp(clock.wall),
        monotonicMs: clock.monotonic,
        evidenceRef: evidenceDigest,
        recoveryReason: "verification_unavailable"
      });
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
    return this.load(operationId).operation;
  }

  async reconcile({
    operationId, descriptor, idempotency = null, invoke,
    probeNow, sleep
  } = {}) {
    verifyVerificationProbe(descriptor);
    const prepared = this.#prepareReconciliation(operationId, descriptor);
    const reconciliation = prepared.operation.reconciliation;
    const attempts = reconciliation.attempts;
    const last = attempts.at(-1);
    if (["committed", "not_committed"].includes(last?.classification)) {
      const outcome = last.classification === "committed"
        ? "verified_committed"
        : "verified_not_committed";
      return this.#finishReconciliation({
        operationId,
        outcome,
        runEvidenceDigest: reconciliationRunEvidenceDigest({
          operationId,
          descriptorDigest: descriptor.descriptor_digest,
          attempts,
          reason: "recovered_terminal_attempt"
        })
      });
    }
    const elapsed = Math.max(
      0, prepared.wall - Date.parse(reconciliation.started_at)
    );
    const remainingAttempts =
      reconciliation.max_attempts - attempts.length;
    const remainingTime =
      Date.parse(reconciliation.deadline_at) - prepared.wall;
    if (remainingAttempts < 1 || remainingTime < 1) {
      return this.#finishReconciliation({
        operationId,
        outcome: "manual_resolution",
        runEvidenceDigest: reconciliationRunEvidenceDigest({
          operationId,
          descriptorDigest: descriptor.descriptor_digest,
          attempts,
          reason: "verification_budget_exhausted"
        })
      });
    }
    const runner = {
      descriptor,
      operation: prepared.operation,
      idempotency,
      invoke,
      attemptOffset: attempts.length,
      attemptLimit: remainingAttempts,
      elapsedOffsetMs: Math.min(
        elapsed, descriptor.limits.total_timeout_ms
      ),
      totalTimeoutMs: Math.min(
        remainingTime, descriptor.limits.total_timeout_ms
      ),
      onAttempt: (record) => this.#appendReconciliationAttempt({
        operationId,
        descriptorDigest: descriptor.descriptor_digest,
        record
      })
    };
    if (probeNow !== undefined) runner.now = probeNow;
    if (sleep !== undefined) runner.sleep = sleep;
    const run = await runVerificationProbe(runner);
    return this.#finishReconciliation({
      operationId,
      outcome: run.outcome === "ambiguous"
        ? "manual_resolution"
        : run.outcome,
      runEvidenceDigest: run.evidence_digest
    });
  }

  recover() {
    const clock = this.#begin();
    let recovered;
    try {
      recovered = recoverOperations(this.#database, {
        observedAt: timestamp(clock.wall),
        monotonicMs: clock.monotonic
      });
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
    return deepFreeze(recovered);
  }

  load(operationId) {
    const loaded = loadOperation(this.#database, operationId);
    return loaded
      ? loadOperationReconciliation(this.#database, loaded)
      : undefined;
  }

  close() {
    this.#database.close();
  }

  #change({ operationId, fromState, toState }) {
    const clock = this.#begin();
    try {
      transitionOperation(this.#database, {
        operationId,
        fromState,
        toState,
        certainty: "not_started",
        observedAt: timestamp(clock.wall),
        monotonicMs: clock.monotonic
      });
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
    return this.load(operationId).operation;
  }

  #prepareReconciliation(operationId, descriptor) {
    const clock = this.#begin();
    try {
      const operation = this.#database.prepare(
        "SELECT * FROM operations WHERE operation_id=?"
      ).get(operationId);
      if (!operation ||
          operation.capability_id !== descriptor.capability_id ||
          operation.capability_revision !== descriptor.capability_revision) {
        operationFail("EG_RECONCILIATION_OPERATION_MISMATCH");
      }
      if (operation.state === "uncertain") {
        const startedAt = timestamp(clock.wall);
        const deadlineAt = timestamp(
          clock.wall + descriptor.limits.total_timeout_ms
        );
        this.#database.prepare(`INSERT INTO operation_reconciliations
          (operation_id, descriptor_digest, started_at, deadline_at,
           max_attempts) VALUES (?, ?, ?, ?, ?)`).run(
          operationId, descriptor.descriptor_digest, startedAt, deadlineAt,
          descriptor.limits.max_attempts
        );
        transitionOperation(this.#database, {
          operationId,
          fromState: "uncertain",
          toState: "reconciling",
          certainty: operation.certainty,
          observedAt: startedAt,
          monotonicMs: clock.monotonic,
          evidenceRef: descriptor.descriptor_digest
        });
      } else if (operation.state === "reconciling") {
        const existing = this.#database.prepare(`SELECT descriptor_digest
          FROM operation_reconciliations WHERE operation_id=?`
        ).get(operationId);
        if (existing?.descriptor_digest !== descriptor.descriptor_digest) {
          operationFail("EG_RECONCILIATION_DESCRIPTOR_MISMATCH");
        }
      } else {
        operationFail(
          operation.state === "executing"
            ? "EG_RECONCILIATION_REQUIRES_UNCERTAIN"
            : "EG_OPERATION_RETRY_DENIED"
        );
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
    return {
      wall: clock.wall,
      operation: this.load(operationId).operation
    };
  }

  #appendReconciliationAttempt({
    operationId, descriptorDigest, record
  }) {
    const clock = this.#begin();
    try {
      const operation = this.#database.prepare(
        "SELECT state FROM operations WHERE operation_id=?"
      ).get(operationId);
      const reconciliation = this.#database.prepare(`SELECT descriptor_digest
        FROM operation_reconciliations WHERE operation_id=?`
      ).get(operationId);
      const count = this.#database.prepare(`SELECT COUNT(*) AS count
        FROM operation_verification_attempts WHERE operation_id=?`
      ).get(operationId)?.count;
      if (operation?.state !== "reconciling" ||
          reconciliation?.descriptor_digest !== descriptorDigest ||
          record?.attempt !== count + 1) {
        operationFail("EG_RECONCILIATION_ATTEMPT_ORDER");
      }
      const attempt = reconciliationAttemptRecord({
        operationId,
        record,
        observedAt: timestamp(clock.wall)
      });
      this.#database.prepare(`INSERT INTO operation_verification_attempts
        (operation_id, attempt, classification, evidence_ref,
         evidence_digest, result_digest, safe_reason_code, observed_at,
         attempt_digest) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        attempt.operation_id, attempt.attempt, attempt.classification,
        attempt.evidence_ref, attempt.evidence_digest,
        attempt.result_digest, attempt.safe_reason_code,
        attempt.observed_at, attempt.attempt_digest
      );
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  #finishReconciliation({ operationId, outcome, runEvidenceDigest }) {
    const clock = this.#begin();
    try {
      const operation = this.#database.prepare(
        "SELECT * FROM operations WHERE operation_id=?"
      ).get(operationId);
      const reconciliation = this.#database.prepare(`SELECT *
        FROM operation_reconciliations WHERE operation_id=?`
      ).get(operationId);
      const attempts = this.#database.prepare(`SELECT *
        FROM operation_verification_attempts WHERE operation_id=?
        ORDER BY attempt`).all(operationId);
      if (operation?.state !== "reconciling" || !reconciliation ||
          this.#database.prepare(`SELECT 1
            FROM operation_reconciliation_outcomes WHERE operation_id=?`
          ).get(operationId)) {
        operationFail("EG_OPERATION_RETRY_DENIED");
      }
      const finalizedAt = timestamp(clock.wall);
      const result = reconciliationOutcomeRecord({
        operationId,
        descriptorDigest: reconciliation.descriptor_digest,
        outcome,
        runEvidenceDigest,
        finalizedAt,
        attempts
      });
      this.#database.prepare(`INSERT INTO operation_reconciliation_outcomes
        (operation_id, outcome, run_evidence_digest, finalized_at,
         outcome_digest) VALUES (?, ?, ?, ?, ?)`).run(
        result.operation_id, result.outcome, result.run_evidence_digest,
        result.finalized_at, result.outcome_digest
      );
      transitionOperation(this.#database, {
        operationId,
        fromState: "reconciling",
        toState: outcome,
        certainty: outcome === "manual_resolution"
          ? operation.certainty
          : outcome,
        observedAt: finalizedAt,
        monotonicMs: clock.monotonic,
        evidenceRef: result.outcome_digest,
        recoveryReason: outcome === "manual_resolution"
          ? "verification_ambiguous"
          : null
      });
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
    return this.load(operationId).operation;
  }

  #begin() {
    const wall = this.#now();
    const monotonic = this.#monotonic();
    if (!Number.isSafeInteger(wall) || !Number.isFinite(monotonic) ||
        monotonic < this.#lastMonotonic ||
        Number.isNaN(new Date(wall).getTime())) {
      operationFail("EG_OPERATION_CLOCK_INVALID");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const maximum = this.#database.prepare(
        "SELECT max_wall_ms FROM operation_clock WHERE singleton=1"
      ).get().max_wall_ms;
      if (wall < maximum) operationFail("EG_OPERATION_CLOCK_ROLLBACK");
      this.#database.prepare(
        "UPDATE operation_clock SET max_wall_ms=? WHERE singleton=1"
      ).run(wall);
      this.#lastMonotonic = monotonic;
      return { wall, monotonic };
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  #rollback() {
    try {
      this.#database.exec("ROLLBACK");
    } catch {}
  }
}
