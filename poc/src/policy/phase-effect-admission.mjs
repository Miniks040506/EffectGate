import { compileEffectIntent } from "./effect-intent.mjs";
import { MAX_CHALLENGE_TTL_MS } from "./approval-lease-contract.mjs";
import { ApprovalLeaseStore } from "./approval-lease-store.mjs";
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
