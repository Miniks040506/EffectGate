import { createHash } from "node:crypto";

import {
  canonicalJson,
  deepFreeze
} from "../skill/passport-compiler.mjs";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const EFFECTS = new Set([
  "observe", "disclose", "mutate_reversible", "mutate_irreversible",
  "destructive", "external_commit", "credential_use", "code_execution"
]);
const ADMISSION_KEYS = [
  "schema_version", "transaction_id", "skill_id", "skill_digest", "phase",
  "phase_revision", "capsule_digest", "capability_id",
  "capability_revision", "effect_class"
];
const INTENT_KEYS = [
  "schema_version", "principal_id", "client_id", "session_id",
  "transaction_id", "skill_id", "skill_digest", "phase", "phase_revision",
  "capsule_digest", "capability_id", "capability_revision", "effect_class",
  "canonical_arguments_hash", "resource_scope", "disclosure_digest",
  "policy_revision", "expires_at", "intent_digest"
];
const MAX_ARGUMENT_BYTES = 256 * 1024;
const MAX_ARGUMENT_NODES = 10_000;
const MAX_ARGUMENT_DEPTH = 32;

function invalid(message = "effect intent is invalid") {
  throw new TypeError(message);
}

function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !keys.includes(key))) {
    invalid();
  }
}

function bounded(value, maximum, pattern) {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= maximum && Buffer.byteLength(value, "utf8") <= maximum * 4 &&
    !value.includes("\0") && value === value.normalize("NFC") &&
    (!pattern || pattern.test(value));
}

function normalizeJson(value, state, depth = 0) {
  state.nodes += 1;
  if (state.nodes > MAX_ARGUMENT_NODES || depth > MAX_ARGUMENT_DEPTH) invalid();
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) invalid();
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === "string") return value.normalize("NFC");
  if (Array.isArray(value)) {
    if (Reflect.ownKeys(value).length !== value.length + 1 ||
        Array.from({ length: value.length }, (_, index) =>
          Object.hasOwn(value, index)).some((present) => !present)) {
      invalid("arguments must not contain sparse or extended arrays");
    }
    return value.map((item) => normalizeJson(item, state, depth + 1));
  }
  if (!value || typeof value !== "object" ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) {
    invalid();
  }
  const keys = Object.keys(value);
  if (Reflect.ownKeys(value).length !== keys.length ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
      })) {
    invalid("arguments must contain only enumerable data fields");
  }
  const entries = keys.map((key) => [
    key.normalize("NFC"), normalizeJson(value[key], state, depth + 1)]);
  if (new Set(entries.map(([key]) => key)).size !== entries.length) {
    invalid("argument keys collide after Unicode normalization");
  }
  return Object.fromEntries(entries);
}

function hash(domain, value) {
  return `sha256:${createHash("sha256")
    .update(`${domain}\0`)
    .update(canonicalJson(value))
    .digest("hex")}`;
}

export function canonicalArgumentsHash(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
  const normalized = normalizeJson(value, { nodes: 0 });
  if (Buffer.byteLength(canonicalJson(normalized)) > MAX_ARGUMENT_BYTES) {
    invalid("canonical arguments exceed the byte limit");
  }
  return hash("effectgate.arguments.v1", normalized);
}

function validateAdmission(value) {
  exactObject(value, ADMISSION_KEYS);
  if (value.schema_version !== "1.0.0" ||
      !bounded(value.transaction_id, 128) ||
      !bounded(value.skill_id, 128, NAME) ||
      !DIGEST.test(value.skill_digest ?? "") ||
      !bounded(value.phase, 128, NAME) ||
      !Number.isSafeInteger(value.phase_revision) ||
      value.phase_revision < 1 ||
      !DIGEST.test(value.capsule_digest ?? "") ||
      !bounded(value.capability_id, 512) ||
      !bounded(value.capability_revision, 256) ||
      !EFFECTS.has(value.effect_class)) {
    invalid("phase admission is invalid");
  }
}

function validateDecision(value) {
  exactObject(value, [
    "decision", "policy_revision", "matched_rule_ids", "safe_reason_code"
  ]);
  if (!["allow", "ask"].includes(value.decision) ||
      !DIGEST.test(value.policy_revision ?? "") ||
      !Array.isArray(value.matched_rule_ids) ||
      value.matched_rule_ids.length > 1024 ||
      new Set(value.matched_rule_ids).size !== value.matched_rule_ids.length ||
      value.matched_rule_ids.some((id) => !bounded(id, 128, NAME)) ||
      !bounded(value.safe_reason_code, 128)) {
    invalid("policy did not admit the effect");
  }
}

function normalizeScope(value) {
  exactObject(value, ["kind", "value"]);
  if (!["exact", "prefix"].includes(value.kind) ||
      !bounded(value.value, 2048)) {
    invalid("resource scope is invalid");
  }
  return { kind: value.kind, value: value.value };
}

function timestamp(value, now) {
  let canonical;
  try {
    canonical = new Date(value).toISOString();
  } catch {
    invalid("intent expiry is invalid");
  }
  const current = now();
  if (canonical !== value || !Number.isFinite(current) ||
      Date.parse(canonical) <= current) {
    invalid("intent expiry is invalid");
  }
  return canonical;
}

function intentDigest(body) {
  return hash("effectgate.intent.v1", body);
}

export function compileEffectIntent(input = {}) {
  exactObject(input, [
    "principalId", "clientId", "sessionId", "admission", "policyDecision",
    "arguments", "resourceScope", "disclosureDigest", "expiresAt", "now"
  ]);
  const {
    principalId, clientId, sessionId, admission, policyDecision,
    arguments: argumentValue, resourceScope, disclosureDigest, expiresAt,
    now = Date.now
  } = input;
  if (!bounded(principalId, 128) || !bounded(clientId, 128) ||
      !bounded(sessionId, 128) || !DIGEST.test(disclosureDigest ?? "") ||
      typeof now !== "function") {
    invalid();
  }
  validateAdmission(admission);
  validateDecision(policyDecision);
  const body = {
    schema_version: "1.0.0",
    principal_id: principalId,
    client_id: clientId,
    session_id: sessionId,
    transaction_id: admission.transaction_id,
    skill_id: admission.skill_id,
    skill_digest: admission.skill_digest,
    phase: admission.phase,
    phase_revision: admission.phase_revision,
    capsule_digest: admission.capsule_digest,
    capability_id: admission.capability_id,
    capability_revision: admission.capability_revision,
    effect_class: admission.effect_class,
    canonical_arguments_hash: canonicalArgumentsHash(argumentValue),
    resource_scope: normalizeScope(resourceScope),
    disclosure_digest: disclosureDigest,
    policy_revision: policyDecision.policy_revision,
    expires_at: timestamp(expiresAt, now)
  };
  return deepFreeze({ ...body, intent_digest: intentDigest(body) });
}

export function verifyEffectIntent(value) {
  exactObject(value, INTENT_KEYS);
  const { intent_digest: claimed, ...body } = value;
  validateAdmission({
    schema_version: value.schema_version,
    transaction_id: value.transaction_id,
    skill_id: value.skill_id,
    skill_digest: value.skill_digest,
    phase: value.phase,
    phase_revision: value.phase_revision,
    capsule_digest: value.capsule_digest,
    capability_id: value.capability_id,
    capability_revision: value.capability_revision,
    effect_class: value.effect_class
  });
  let expiry;
  try {
    expiry = new Date(value.expires_at).toISOString();
  } catch {
    invalid();
  }
  if (!bounded(value.principal_id, 128) ||
      !bounded(value.client_id, 128) ||
      !bounded(value.session_id, 128) ||
      !DIGEST.test(value.canonical_arguments_hash ?? "") ||
      !DIGEST.test(value.disclosure_digest ?? "") ||
      !DIGEST.test(value.policy_revision ?? "") ||
      canonicalJson(normalizeScope(value.resource_scope)) !==
        canonicalJson(value.resource_scope) ||
      expiry !== value.expires_at ||
      !DIGEST.test(claimed ?? "") ||
      intentDigest(body) !== claimed) {
    invalid();
  }
  return value;
}

function scopeReason(before, after) {
  if (before.kind === "exact" && after.kind === "prefix") {
    return "scope_widened";
  }
  if (before.kind === "prefix" && after.kind === "prefix" &&
      before.value !== after.value && before.value.startsWith(after.value)) {
    return "scope_widened";
  }
  return "target_changed";
}

export function diffEffectIntents(before, after) {
  verifyEffectIntent(before);
  verifyEffectIntent(after);
  const reasons = [];
  const fields = [
    ["principal_id", "principal_changed"],
    ["client_id", "client_changed"],
    ["session_id", "session_changed"],
    ["transaction_id", "transaction_changed"],
    ["skill_id", "skill_changed"],
    ["skill_digest", "skill_changed"],
    ["phase", "phase_changed"],
    ["phase_revision", "phase_changed"],
    ["capsule_digest", "capsule_changed"],
    ["capability_id", "capability_changed"],
    ["capability_revision", "capability_revision_changed"],
    ["effect_class", "effect_class_changed"],
    ["canonical_arguments_hash", "arguments_changed"],
    ["disclosure_digest", "disclosure_changed"],
    ["policy_revision", "policy_revision_changed"],
    ["expires_at", "expiry_changed"]
  ];
  for (const [field, reason] of fields) {
    if (before[field] !== after[field] && !reasons.includes(reason)) {
      reasons.push(reason);
    }
  }
  if (canonicalJson(before.resource_scope) !==
      canonicalJson(after.resource_scope)) {
    reasons.push(scopeReason(before.resource_scope, after.resource_scope));
  }
  return deepFreeze({
    changed: reasons.length > 0,
    invalidation_reasons: reasons
  });
}
