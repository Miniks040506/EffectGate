import { compileEffectIntent } from "./effect-intent.mjs";
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
