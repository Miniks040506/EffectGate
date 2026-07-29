import { compileEffectIntent } from "./effect-intent.mjs";
import { MAX_CHALLENGE_TTL_MS } from "./approval-lease-contract.mjs";
import { ApprovalLeaseStore } from "./approval-lease-store.mjs";
import { prepareIdempotentDispatch } from "./idempotency-adapter.mjs";
import { EffectOperationJournal } from "./operation-journal.mjs";
import { evaluatePolicy } from "./policy-compiler.mjs";
import { deepFreeze } from "../skill/passport-compiler.mjs";
import { SkillTransaction } from "../skill/phase-transaction.mjs";

const INPUT_KEYS = new Set([
  "transaction",
  "capsule",
  "capsuleDigest",
  "capabilityId",
  "capabilityRevision",
  "effectClass",
  "policy",
  "principalId",
  "clientId",
  "sessionId",
  "arguments",
  "resourceScope",
  "disclosureDigest",
  "expiresAt",
  "now"
]);
const PLAN_KEYS = new Set([
  "operationId",
  "journal",
  "approvals",
  "effect",
  "challengeTtlMs"
]);
const ADMIT_KEYS = new Set([
  "operationId",
  "approvals",
  "leaseToken",
  "intent",
  "effect"
]);
const DISPATCH_KEYS = new Set([
  "operationId",
  "journal",
  "effect",
  "adapter",
  "request",
  "deadlineAt",
  "invoke"
]);
const COMPLETE_KEYS = new Set([
  "operationId",
  "receiptId",
  "journal",
  "transaction",
  "signer"
]);

export class EffectAdmissionError extends Error {
  constructor(safeReasonCode) {
    super("effect is not admissible");
    this.name = "EffectAdmissionError";
    this.code = "EG_EFFECT_ADMISSION_DENIED";
    this.safeReasonCode = safeReasonCode;
  }
}

export function preparePhaseEffect(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !INPUT_KEYS.has(key)) ||
      !(input.transaction instanceof SkillTransaction)) {
    throw new TypeError("invalid phase effect preparation");
  }
  const {
    transaction,
    capsule,
    capsuleDigest,
    capabilityId,
    capabilityRevision,
    effectClass,
    policy,
    principalId,
    clientId,
    sessionId,
    arguments: argumentValue,
    resourceScope,
    disclosureDigest,
    expiresAt,
    now = Date.now
  } = input;
  const admission = SkillTransaction.prototype.admitTool.call(
    transaction,
    {
      capsule,
      capsuleDigest,
      capabilityId,
      capabilityRevision,
      effectClass
    }
  );
  const policyDecision = evaluatePolicy(policy, admission);
  if (policyDecision.decision === "deny") {
    throw new EffectAdmissionError(policyDecision.safe_reason_code);
  }
  const intent = compileEffectIntent({
    principalId,
    clientId,
    sessionId,
    admission,
    policyDecision,
    arguments: argumentValue,
    resourceScope,
    disclosureDigest,
    expiresAt,
    now
  });
  const approvalRequired = policyDecision.decision === "ask";
  return deepFreeze({
    schema_version: "1.0.0",
    status: approvalRequired ? "approval_required" : "policy_allowed",
    approval_required: approvalRequired,
    admission,
    policy_decision: policyDecision,
    intent
  });
}

export function planPhaseEffectOperation(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !PLAN_KEYS.has(key)) ||
      !(input.journal instanceof EffectOperationJournal)) {
    throw new TypeError("invalid phase effect operation plan");
  }
  const {
    operationId,
    journal,
    approvals,
    effect,
    challengeTtlMs
  } = input;
  const prepared = preparePhaseEffect(effect);
  if ((approvals !== undefined &&
        !(approvals instanceof ApprovalLeaseStore)) ||
      (challengeTtlMs !== undefined &&
        (!Number.isSafeInteger(challengeTtlMs) ||
          challengeTtlMs < 1 ||
          challengeTtlMs > MAX_CHALLENGE_TTL_MS)) ||
      (!prepared.approval_required && challengeTtlMs !== undefined)) {
    throw new TypeError("invalid phase effect approval configuration");
  }
  if (prepared.approval_required &&
      !(approvals instanceof ApprovalLeaseStore)) {
    throw new EffectAdmissionError("approval_unavailable");
  }
  EffectOperationJournal.prototype.plan.call(journal, {
    operationId,
    intent: prepared.intent,
    approvalRequired: prepared.approval_required
  });
  EffectOperationJournal.prototype.preflight.call(journal, operationId);
  let challenge = null;
  if (prepared.approval_required) {
    challenge = ApprovalLeaseStore.prototype.createChallenge.call(
      approvals,
      {
        intent: prepared.intent,
        ...(challengeTtlMs === undefined
          ? {}
          : { ttlMs: challengeTtlMs })
      }
    );
    EffectOperationJournal.prototype.awaitApproval.call(journal, {
      operationId,
      challengeId: challenge.challenge_id
    });
  } else {
    EffectOperationJournal.prototype.admit.call(journal, operationId);
  }
  const operation = EffectOperationJournal.prototype.load.call(
    journal,
    operationId
  ).operation;
  return deepFreeze({
    schema_version: "1.0.0",
    status: operation.state,
    operation_id: operationId,
    approval_required: prepared.approval_required,
    intent: prepared.intent,
    challenge,
    policy_decision: prepared.policy_decision
  });
}

export function admitPhaseEffectOperation(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !ADMIT_KEYS.has(key)) ||
      !(input.approvals instanceof ApprovalLeaseStore)) {
    throw new TypeError("invalid phase effect approval admission");
  }
  const current = preparePhaseEffect(input.effect);
  if (!current.approval_required ||
      current.intent.intent_digest !== input.intent?.intent_digest) {
    throw new EffectAdmissionError("intent_changed");
  }
  const proof = ApprovalLeaseStore.prototype.admitOperation.call(
    input.approvals,
    {
      leaseToken: input.leaseToken,
      intent: input.intent,
      operationId: input.operationId
    }
  );
  return deepFreeze({
    schema_version: "1.0.0",
    status: "admitted",
    operation_id: input.operationId,
    intent_digest: input.intent.intent_digest,
    approval_proof: proof
  });
}

export async function dispatchPhaseEffectOperation(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !DISPATCH_KEYS.has(key)) ||
      !(input.journal instanceof EffectOperationJournal) ||
      typeof input.invoke !== "function") {
    throw new TypeError("invalid phase effect dispatch");
  }
  const current = preparePhaseEffect(input.effect);
  const operation = EffectOperationJournal.prototype.load.call(
    input.journal,
    input.operationId
  )?.operation;
  if (operation?.intent_digest !== current.intent.intent_digest) {
    throw new EffectAdmissionError("intent_changed");
  }
  const prepared = prepareIdempotentDispatch({
    adapter: input.adapter,
    operation,
    request: input.request
  });
  EffectOperationJournal.prototype.beginDispatch.call(input.journal, {
    operationId: input.operationId,
    dispatchDigest: prepared.dispatch_digest,
    deadlineAt: input.deadlineAt,
    idempotency: prepared.idempotency
  });
  try {
    await input.invoke(prepared.request);
    return deepFreeze({
      schema_version: "1.0.0",
      status: "executing",
      operation_id: input.operationId,
      response_received: true,
      idempotency: prepared.idempotency
    });
  } catch {
    EffectOperationJournal.prototype.markUncertain.call(input.journal, {
      operationId: input.operationId,
      certainty: "commit_possible",
      evidenceRef: prepared.dispatch_digest,
      reason: "response_lost_after_dispatch"
    });
    return deepFreeze({
      schema_version: "1.0.0",
      status: "uncertain",
      operation_id: input.operationId,
      response_received: false,
      safe_reason_code: "response_lost_after_dispatch",
      idempotency: prepared.idempotency
    });
  }
}

export function completePhaseEffectOperation(input = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).some((key) => !COMPLETE_KEYS.has(key)) ||
      !(input.journal instanceof EffectOperationJournal) ||
      !(input.transaction instanceof SkillTransaction)) {
    throw new TypeError("invalid phase effect completion");
  }
  const operation = EffectOperationJournal.prototype.load.call(
    input.journal,
    input.operationId
  )?.operation;
  if (operation?.state !== "verified_committed" ||
      operation.certainty !== "verified_committed") {
    throw new EffectAdmissionError("verification_required");
  }
  const phase = SkillTransaction.prototype.snapshot.call(
    input.transaction
  );
  if (operation.transaction_id !== phase.transaction_id ||
      operation.phase !== phase.current_phase ||
      operation.phase_revision !== phase.next_phase_revision ||
      operation.capsule_digest !== phase.active_capsule_digest) {
    throw new EffectAdmissionError("phase_changed");
  }
  let receipt = EffectOperationJournal.prototype.loadReceipt.call(
    input.journal,
    input.receiptId
  );
  if (receipt === undefined) {
    receipt = EffectOperationJournal.prototype.issueReceipt.call(
      input.journal,
      {
        receiptId: input.receiptId,
        operationId: input.operationId,
        signer: input.signer ?? null
      }
    );
  }
  if (receipt.operation_id !== operation.operation_id ||
      receipt.intent_digest !== operation.intent_digest ||
      receipt.transaction_id !== operation.transaction_id ||
      receipt.phase !== operation.phase ||
      receipt.phase_revision !== operation.phase_revision ||
      receipt.capsule_digest !== operation.capsule_digest ||
      receipt.final_state !== "verified_committed") {
    throw new EffectAdmissionError("receipt_mismatch");
  }
  const phaseReceipt =
    SkillTransaction.prototype.reportPhaseOutcome.call(
      input.transaction,
      {
        capsuleDigest: operation.capsule_digest,
        status: "completed",
        effectReceiptRefs: [
          `receipt://effect/${receipt.receipt_id}`
        ]
      }
    );
  return deepFreeze({
    schema_version: "1.0.0",
    status: "completed",
    operation_id: input.operationId,
    effect_receipt: receipt,
    phase_receipt: phaseReceipt
  });
}
