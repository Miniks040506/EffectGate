import { createHash } from "node:crypto";

import {
  OPERATION_PATTERNS,
  boundedOperationValue
} from "./operation-journal-contract.mjs";
import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";

const FIELD = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u;
const KINDS = new Set([
  "lookup_by_idempotency_key",
  "lookup_by_fingerprint",
  "read_after_write",
  "resource_version_match"
]);
const SOURCES = new Set([
  "intent_digest",
  "canonical_arguments_hash",
  "resource_scope_kind",
  "resource_scope_value",
  "capability_id",
  "capability_revision",
  "transaction_id",
  "idempotency_key"
]);
const DESCRIPTOR_KEYS = [
  "schema_version", "capability_id", "capability_revision", "kind", "probe",
  "arguments", "predicates", "limits", "evidence",
  "qualification_evidence_digest"
];

export class VerificationProbeError extends Error {
  constructor(code = "EG_VERIFICATION_NOT_ADMISSIBLE") {
    super("verification probe is not admissible");
    this.name = "VerificationProbeError";
    this.code = code;
  }
}

function fail(code) {
  throw new VerificationProbeError(code);
}

function exactObject(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
      })) {
    fail("EG_VERIFICATION_CONTRACT_INVALID");
  }
}

function digest(domain, value) {
  return `sha256:${createHash("sha256")
    .update(`${domain}\0`)
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function scalar(value) {
  return value === null || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    boundedOperationValue(value, 1024);
}

function validatePointer(value) {
  if (!boundedOperationValue(value, 512) || !value.startsWith("/")) {
    fail("EG_VERIFICATION_CONTRACT_INVALID");
  }
  const segments = value.slice(1).split("/");
  if (segments.length > 16 || segments.some((segment) =>
    segment.length === 0 || /~(?![01])/u.test(segment))) {
    fail("EG_VERIFICATION_CONTRACT_INVALID");
  }
}

function normalizeExpected(value) {
  exactObject(
    value,
    Object.hasOwn(value ?? {}, "source") ? ["source"] : ["literal"]
  );
  if (Object.hasOwn(value, "source")) {
    if (!SOURCES.has(value.source)) {
      fail("EG_VERIFICATION_CONTRACT_INVALID");
    }
    return { source: value.source };
  }
  if (!scalar(value.literal)) fail("EG_VERIFICATION_CONTRACT_INVALID");
  return {
    literal: typeof value.literal === "string"
      ? value.literal.normalize("NFC")
      : Object.is(value.literal, -0) ? 0 : value.literal
  };
}

function normalizePredicate(value) {
  exactObject(value, ["path", "equals"]);
  validatePointer(value.path);
  return { path: value.path, equals: normalizeExpected(value.equals) };
}

function normalizePredicateList(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) {
    fail("EG_VERIFICATION_CONTRACT_INVALID");
  }
  const predicates = value.map(normalizePredicate)
    .sort((left, right) =>
      canonicalJson(left).localeCompare(canonicalJson(right)));
  if (new Set(predicates.map(canonicalJson)).size !== predicates.length) {
    fail("EG_VERIFICATION_CONTRACT_INVALID");
  }
  return predicates;
}

function normalizeArguments(value, kind) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 16) {
    fail("EG_VERIFICATION_CONTRACT_INVALID");
  }
  const bindings = value.map((binding) => {
    exactObject(binding, ["name", "source"]);
    if (!FIELD.test(binding.name ?? "") || !SOURCES.has(binding.source)) {
      fail("EG_VERIFICATION_CONTRACT_INVALID");
    }
    return { name: binding.name, source: binding.source };
  }).sort((left, right) => left.name.localeCompare(right.name));
  if (new Set(bindings.map(({ name }) => name)).size !== bindings.length) {
    fail("EG_VERIFICATION_CONTRACT_INVALID");
  }
  const sources = new Set(bindings.map(({ source }) => source));
  const required = {
    lookup_by_idempotency_key: "idempotency_key",
    lookup_by_fingerprint: "canonical_arguments_hash",
    read_after_write: "resource_scope_value",
    resource_version_match: "resource_scope_value"
  }[kind];
  if (!sources.has(required) ||
      (kind !== "lookup_by_idempotency_key" &&
        sources.has("idempotency_key"))) {
    fail("EG_VERIFICATION_CONTRACT_INVALID");
  }
  return bindings;
}

function descriptorBody(value) {
  exactObject(value, DESCRIPTOR_KEYS);
  exactObject(value.probe, [
    "capability_id", "capability_revision", "effect_class"
  ]);
  exactObject(value.predicates, [
    "committed", "not_committed", "ambiguous"
  ]);
  exactObject(value.limits, [
    "max_attempts", "per_attempt_timeout_ms", "total_timeout_ms",
    "max_result_bytes", "initial_backoff_ms", "max_backoff_ms",
    "observation_window_ms"
  ]);
  exactObject(value.evidence, ["trust_level", "redaction"]);
  const limits = value.limits;
  if (value.schema_version !== "1.0.0" ||
      !boundedOperationValue(value.capability_id, 512) ||
      !boundedOperationValue(value.capability_revision, 256) ||
      !KINDS.has(value.kind) ||
      !boundedOperationValue(value.probe.capability_id, 512) ||
      !boundedOperationValue(value.probe.capability_revision, 256) ||
      value.probe.capability_id === value.capability_id ||
      value.probe.effect_class !== "observe" ||
      !Number.isSafeInteger(limits.max_attempts) ||
      limits.max_attempts < 1 || limits.max_attempts > 10 ||
      !Number.isSafeInteger(limits.per_attempt_timeout_ms) ||
      limits.per_attempt_timeout_ms < 1 ||
      limits.per_attempt_timeout_ms > 60_000 ||
      !Number.isSafeInteger(limits.total_timeout_ms) ||
      limits.total_timeout_ms < limits.per_attempt_timeout_ms ||
      limits.total_timeout_ms > 300_000 ||
      !Number.isSafeInteger(limits.max_result_bytes) ||
      limits.max_result_bytes < 1 || limits.max_result_bytes > 262_144 ||
      !Number.isSafeInteger(limits.initial_backoff_ms) ||
      limits.initial_backoff_ms < 0 ||
      limits.initial_backoff_ms > 60_000 ||
      !Number.isSafeInteger(limits.max_backoff_ms) ||
      limits.max_backoff_ms < limits.initial_backoff_ms ||
      limits.max_backoff_ms > 60_000 ||
      !Number.isSafeInteger(limits.observation_window_ms) ||
      limits.observation_window_ms < 0 ||
      limits.observation_window_ms > limits.total_timeout_ms ||
      value.evidence.trust_level !== "qualified_probe" ||
      value.evidence.redaction !== "digest_only" ||
      !OPERATION_PATTERNS.digest.test(
        value.qualification_evidence_digest ?? ""
      )) {
    fail("EG_VERIFICATION_CONTRACT_INVALID");
  }
  return {
    schema_version: "1.0.0",
    capability_id: value.capability_id,
    capability_revision: value.capability_revision,
    kind: value.kind,
    probe: {
      capability_id: value.probe.capability_id,
      capability_revision: value.probe.capability_revision,
      effect_class: "observe"
    },
    arguments: normalizeArguments(value.arguments, value.kind),
    predicates: {
      committed: normalizePredicateList(value.predicates.committed),
      not_committed: normalizePredicateList(
        value.predicates.not_committed
      ),
      ambiguous: normalizePredicateList(value.predicates.ambiguous)
    },
    limits: { ...limits },
    evidence: {
      trust_level: "qualified_probe",
      redaction: "digest_only"
    },
    qualification_evidence_digest: value.qualification_evidence_digest
  };
}

export function compileVerificationProbe(input = {}) {
  const body = descriptorBody(input);
  return deepFreeze({
    ...body,
    descriptor_digest: digest("effectgate.verification-probe.v1", body)
  });
}

export function verifyVerificationProbe(value) {
  exactObject(value, [...DESCRIPTOR_KEYS, "descriptor_digest"]);
  const { descriptor_digest: claimed, ...input } = value;
  const compiled = compileVerificationProbe(input);
  if (claimed !== compiled.descriptor_digest) {
    fail("EG_VERIFICATION_CONTRACT_INVALID");
  }
  return value;
}
