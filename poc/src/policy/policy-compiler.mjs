import { createHash } from "node:crypto";
import {
  canonicalJson,
  deepFreeze
} from "../skill/passport-compiler.mjs";

export const POLICY_COMPILER_VERSION = "0.1.0";

const NAME = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const VERSION =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const DECISIONS = new Set(["allow", "ask", "deny"]);
const EFFECTS = new Set([
  "observe", "disclose", "mutate_reversible", "mutate_irreversible",
  "destructive", "external_commit", "credential_use", "code_execution",
  "unknown"
]);
const MATCH_KEYS = [
  "skill_id", "skill_digest", "phase", "phase_revision", "capsule_digest",
  "capability_id", "capability_revision", "effect_class"
];
const PROTECTED_BINDINGS = new Set(MATCH_KEYS);

function invalid(message = "policy is invalid") {
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
    !value.includes("\0") && (!pattern || pattern.test(value));
}

function normalizeMatch(match) {
  exactObject(match, MATCH_KEYS);
  const entries = Object.entries(match).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0);
  if (entries.length < 1 ||
      entries.some(([key, value]) => {
        if (key === "phase_revision") {
          return !Number.isSafeInteger(value) || value < 1;
        }
        if (key === "effect_class") return !EFFECTS.has(value);
        if (key.endsWith("_digest")) return !DIGEST.test(value);
        if (key === "skill_id" || key === "phase") {
          return !bounded(value, 128, NAME);
        }
        return !bounded(value, key === "capability_revision" ? 256 : 512);
      })) {
    invalid();
  }
  return Object.fromEntries(entries);
}

function normalizeRule(rule) {
  exactObject(rule, ["id", "match", "decision"]);
  if (!bounded(rule.id, 128, NAME) || !DECISIONS.has(rule.decision)) invalid();
  const match = normalizeMatch(rule.match);
  if (rule.decision !== "deny") {
    if (match.effect_class === undefined || match.effect_class === "unknown") {
      invalid("non-deny rules require a known effect class");
    }
    if (match.effect_class !== "observe" &&
        [...PROTECTED_BINDINGS].some((key) => match[key] === undefined)) {
      invalid("protected-effect rules require exact phase bindings");
    }
  }
  return { id: rule.id, match, decision: rule.decision };
}

function revision(body) {
  return `sha256:${createHash("sha256")
    .update("effectgate.policy.v1\0")
    .update(canonicalJson(body))
    .digest("hex")}`;
}

export function compilePolicy(input = {}) {
  exactObject(input, ["policyId", "rules", "compilerVersion"]);
  const {
    policyId,
    rules,
    compilerVersion = POLICY_COMPILER_VERSION
  } = input;
  if (!bounded(policyId, 128, NAME) ||
      !bounded(compilerVersion, 128, VERSION) ||
      !Array.isArray(rules) || rules.length < 1 || rules.length > 1024) {
    invalid();
  }
  const normalized = rules.map(normalizeRule).sort((left, right) =>
    left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  if (new Set(normalized.map(({ id }) => id)).size !== normalized.length) {
    invalid("policy rule IDs must be unique");
  }
  const body = {
    schema_version: "1.0.0",
    policy_id: policyId,
    default_decision: "deny",
    rules: normalized,
    compiler_version: compilerVersion
  };
  return deepFreeze({ ...body, policy_revision: revision(body) });
}

function denial(policyRevision, reason) {
  return deepFreeze({
    decision: "deny",
    policy_revision: policyRevision ?? null,
    matched_rule_ids: [],
    safe_reason_code: reason
  });
}

function validRequest(value) {
  try {
    exactObject(value, [...MATCH_KEYS, "schema_version", "transaction_id"]);
    if ((value.schema_version !== undefined &&
          value.schema_version !== "1.0.0") ||
        (value.transaction_id !== undefined &&
          !bounded(value.transaction_id, 128))) {
      return false;
    }
    const match = Object.fromEntries(
      MATCH_KEYS.map((key) => [key, value[key]])
    );
    normalizeMatch(match);
    return MATCH_KEYS.every((key) => match[key] !== undefined);
  } catch {
    return false;
  }
}

function verifiedPolicy(policy) {
  try {
    const rebuilt = compilePolicy({
      policyId: policy?.policy_id,
      rules: policy?.rules,
      compilerVersion: policy?.compiler_version
    });
    return canonicalJson(rebuilt) === canonicalJson(policy) ? rebuilt : null;
  } catch {
    return null;
  }
}

export function evaluatePolicy(policy, request) {
  // ponytail: recompile per evaluation until immutable generations live in
  // EG-006 storage; cache verified revisions if policy throughput matters.
  const verified = verifiedPolicy(policy);
  if (!verified) return denial(null, "policy_unavailable");
  if (!validRequest(request)) {
    return denial(verified.policy_revision, "invalid_admission");
  }
  if (request.effect_class === "unknown") {
    return denial(verified.policy_revision, "unknown_effect");
  }
  const matches = verified.rules.filter(({ match }) =>
    Object.entries(match).every(([key, value]) => request[key] === value));
  const ids = matches.map(({ id }) => id);
  const decision = matches.some((rule) => rule.decision === "deny")
    ? "deny"
    : matches.some((rule) => rule.decision === "ask")
      ? "ask"
      : matches.some((rule) => rule.decision === "allow")
        ? "allow"
        : "deny";
  return deepFreeze({
    decision,
    policy_revision: verified.policy_revision,
    matched_rule_ids: ids,
    safe_reason_code:
      matches.length === 0 ? "policy_default_deny" : `policy_${decision}`
  });
}
