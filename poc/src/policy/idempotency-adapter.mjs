import { createHash } from "node:crypto";

import { canonicalArgumentsHash } from "./effect-intent.mjs";
import {
  boundedOperationValue,
  OPERATION_PATTERNS
} from "./operation-journal-contract.mjs";
import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";

const FIELD = /^[A-Za-z_][A-Za-z0-9_.-]{0,127}$/u;
const HEADER = /^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,128}$/u;
const KEY = /^eg_[A-Za-z0-9_-]{43}$/u;
const SCENARIOS = Object.freeze([
  "same_key_same_intent",
  "same_key_different_intent",
  "concurrent_duplicate_calls",
  "server_restart",
  "response_loss_after_commit"
]);
const ADAPTER_KEYS = [
  "schema_version", "capability_id", "capability_revision", "key_placement",
  "lookup", "qualified_scenarios", "qualification_evidence_digest"
];
const BINDING_KEYS = [
  "schema_version", "operation_id", "intent_digest", "adapter_digest", "key",
  "key_hash", "key_target", "key_name", "lookup_capability_id",
  "lookup_capability_revision"
];

export const IDEMPOTENCY_SCHEMA = `
CREATE TABLE IF NOT EXISTS operation_idempotency (
  operation_id TEXT PRIMARY KEY, intent_digest TEXT NOT NULL,
  adapter_digest TEXT NOT NULL, key_hash TEXT NOT NULL UNIQUE,
  key_target TEXT NOT NULL CHECK(key_target IN ('arguments','headers')),
  key_name TEXT NOT NULL, lookup_capability_id TEXT NOT NULL,
  lookup_capability_revision TEXT NOT NULL, created_at TEXT NOT NULL,
  FOREIGN KEY(operation_id) REFERENCES operations(operation_id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS operation_idempotency_no_update
BEFORE UPDATE ON operation_idempotency BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER IF NOT EXISTS operation_idempotency_no_delete
BEFORE DELETE ON operation_idempotency BEGIN SELECT RAISE(ABORT, 'immutable'); END;
PRAGMA user_version=4;
`;

export class IdempotencyAdapterError extends Error {
  constructor(code = "EG_IDEMPOTENCY_NOT_ADMISSIBLE") {
    super("idempotency evidence is not admissible");
    this.name = "IdempotencyAdapterError";
    this.code = code;
  }
}

function fail(code) {
  throw new IdempotencyAdapterError(code);
}

function exactObject(
  value, keys, code = "EG_IDEMPOTENCY_CONTRACT_INVALID"
) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
      })) {
    fail(code);
  }
}

function digest(domain, value) {
  return `sha256:${createHash("sha256")
    .update(`${domain}\0`)
    .update(typeof value === "string" ? value : canonicalJson(value))
    .digest("hex")}`;
}

function adapterBody(value) {
  exactObject(value, ADAPTER_KEYS);
  exactObject(value.key_placement, ["target", "name"]);
  exactObject(value.lookup, [
    "capability_id", "capability_revision", "key_argument"
  ]);
  const fieldPattern = value.key_placement.target === "headers"
    ? HEADER
    : FIELD;
  if (value.schema_version !== "1.0.0" ||
      !boundedOperationValue(value.capability_id, 512) ||
      !boundedOperationValue(value.capability_revision, 256) ||
      !["arguments", "headers"].includes(value.key_placement.target) ||
      !fieldPattern.test(value.key_placement.name ?? "") ||
      !boundedOperationValue(value.lookup.capability_id, 512) ||
      !boundedOperationValue(value.lookup.capability_revision, 256) ||
      !FIELD.test(value.lookup.key_argument ?? "") ||
      !Array.isArray(value.qualified_scenarios) ||
      value.qualified_scenarios.length !== SCENARIOS.length ||
      new Set(value.qualified_scenarios).size !== SCENARIOS.length ||
      SCENARIOS.some((scenario) =>
        !value.qualified_scenarios.includes(scenario)) ||
      !OPERATION_PATTERNS.digest.test(
        value.qualification_evidence_digest ?? ""
      )) {
    fail("EG_IDEMPOTENCY_CONTRACT_INVALID");
  }
  return {
    schema_version: "1.0.0",
    capability_id: value.capability_id,
    capability_revision: value.capability_revision,
    key_placement: {
      target: value.key_placement.target,
      name: value.key_placement.name
    },
    lookup: {
      capability_id: value.lookup.capability_id,
      capability_revision: value.lookup.capability_revision,
      key_argument: value.lookup.key_argument
    },
    qualified_scenarios: [...SCENARIOS],
    qualification_evidence_digest: value.qualification_evidence_digest
  };
}

export function compileIdempotencyAdapter(input = {}) {
  const body = adapterBody(input);
  return deepFreeze({
    ...body,
    adapter_digest: digest("effectgate.idempotency-adapter.v1", body)
  });
}

export function verifyIdempotencyAdapter(value) {
  exactObject(value, [...ADAPTER_KEYS, "adapter_digest"]);
  const { adapter_digest: claimed, ...input } = value;
  const compiled = compileIdempotencyAdapter(input);
  if (claimed !== compiled.adapter_digest) {
    fail("EG_IDEMPOTENCY_CONTRACT_INVALID");
  }
  return value;
}

function derivedKey(operationId, intentDigest, adapterDigest) {
  return `eg_${createHash("sha256")
    .update("effectgate.idempotency-key.v1\0")
    .update(canonicalJson({
      operation_id: operationId,
      intent_digest: intentDigest,
      adapter_digest: adapterDigest
    }))
    .digest("base64url")}`;
}

function bindingFromIdentity(adapter, operationId, intentDigest) {
  verifyIdempotencyAdapter(adapter);
  if (!OPERATION_PATTERNS.identifier.test(operationId ?? "") ||
      !OPERATION_PATTERNS.digest.test(intentDigest ?? "")) {
    fail("EG_IDEMPOTENCY_OPERATION_MISMATCH");
  }
  const key = derivedKey(operationId, intentDigest, adapter.adapter_digest);
  return {
    schema_version: "1.0.0",
    operation_id: operationId,
    intent_digest: intentDigest,
    adapter_digest: adapter.adapter_digest,
    key,
    key_hash: digest("effectgate.idempotency-key-hash.v1", key),
    key_target: adapter.key_placement.target,
    key_name: adapter.key_placement.name,
    lookup_capability_id: adapter.lookup.capability_id,
    lookup_capability_revision: adapter.lookup.capability_revision
  };
}

function bindingFor(adapter, operation) {
  verifyIdempotencyAdapter(adapter);
  if (!operation || operation.schema_version !== "1.0.0" ||
      !["admitted", "executing", "uncertain"].includes(operation.state) ||
      !OPERATION_PATTERNS.digest.test(
        operation.canonical_arguments_hash ?? ""
      ) ||
      operation.capability_id !== adapter.capability_id ||
      operation.capability_revision !== adapter.capability_revision) {
    fail("EG_IDEMPOTENCY_OPERATION_MISMATCH");
  }
  return bindingFromIdentity(
    adapter, operation.operation_id, operation.intent_digest
  );
}

export function deriveIdempotencyBinding({ adapter, operation } = {}) {
  return deepFreeze(bindingFor(adapter, operation));
}

export function verifyIdempotencyBinding({ adapter, binding, operation } = {}) {
  exactObject(binding, BINDING_KEYS, "EG_IDEMPOTENCY_BINDING_MISMATCH");
  const expected = operation
    ? bindingFor(adapter, operation)
    : bindingFromIdentity(
      adapter, binding.operation_id, binding.intent_digest
    );
  if (canonicalJson(binding) !== canonicalJson(expected) ||
      !KEY.test(binding.key)) {
    fail("EG_IDEMPOTENCY_BINDING_MISMATCH");
  }
  return binding;
}

function headers(value = {}) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== Object.keys(value).length ||
      Object.keys(value).length > 128) {
    fail("EG_IDEMPOTENCY_REQUEST_INVALID");
  }
  const output = {};
  const names = new Set();
  for (const name of Object.keys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);
    const normalized = name.toLowerCase();
    if (!descriptor?.enumerable || !Object.hasOwn(descriptor, "value") ||
        !HEADER.test(name) || names.has(normalized) ||
        !boundedOperationValue(descriptor.value, 8192)) {
      fail("EG_IDEMPOTENCY_REQUEST_INVALID");
    }
    names.add(normalized);
    output[name] = descriptor.value;
  }
  return output;
}

export function prepareIdempotentDispatch({
  adapter, operation, request
} = {}) {
  exactObject(
    request, ["arguments", "headers"], "EG_IDEMPOTENCY_REQUEST_INVALID"
  );
  if (operation?.state !== "admitted") {
    fail("EG_IDEMPOTENCY_OPERATION_MISMATCH");
  }
  const binding = bindingFor(adapter, operation);
  const argumentHash = canonicalArgumentsHash(request.arguments);
  const argumentCopy = JSON.parse(canonicalJson(request.arguments));
  const headerCopy = headers(request.headers);
  const target = binding.key_target === "arguments"
    ? argumentCopy
    : headerCopy;
  const conflict = binding.key_target === "headers"
    ? Object.keys(target).some(
      (name) => name.toLowerCase() === binding.key_name.toLowerCase()
    )
    : Object.hasOwn(target, binding.key_name);
  if (conflict) fail("EG_IDEMPOTENCY_KEY_CONFLICT");
  if (argumentHash !== operation.canonical_arguments_hash) {
    fail("EG_IDEMPOTENCY_OPERATION_MISMATCH");
  }
  target[binding.key_name] = binding.key;
  const injected = { arguments: argumentCopy, headers: headerCopy };
  const dispatch = {
    operation_id: operation.operation_id,
    intent_digest: operation.intent_digest,
    capability_id: operation.capability_id,
    capability_revision: operation.capability_revision,
    adapter_digest: adapter.adapter_digest,
    key_hash: binding.key_hash,
    request: injected
  };
  const dispatchDigest = digest(
    "effectgate.idempotent-dispatch.v1", dispatch
  );
  return deepFreeze({
    request: injected,
    dispatch_digest: dispatchDigest,
    idempotency: { adapter, binding, dispatch_digest: dispatchDigest }
  });
}

export function idempotencyMetadata({ adapter, binding, operation } = {}) {
  verifyIdempotencyBinding({ adapter, binding, operation });
  const { key: ignored, ...metadata } = binding;
  return deepFreeze(metadata);
}

export function buildIdempotencyLookup({ adapter, binding } = {}) {
  verifyIdempotencyBinding({ adapter, binding });
  return deepFreeze({
    capability_id: adapter.lookup.capability_id,
    capability_revision: adapter.lookup.capability_revision,
    arguments: { [adapter.lookup.key_argument]: binding.key }
  });
}

export function validateIdempotencyLookup({
  adapter, binding, result
} = {}) {
  verifyIdempotencyBinding({ adapter, binding });
  exactObject(
    result,
    [
      "status", "idempotency_key", "intent_digest", "backend_reference",
      "evidence_digest"
    ],
    "EG_IDEMPOTENCY_LOOKUP_INVALID"
  );
  if (!["found", "not_found", "ambiguous"].includes(result.status) ||
      result.idempotency_key !== binding.key ||
      !OPERATION_PATTERNS.digest.test(result.evidence_digest ?? "")) {
    fail("EG_IDEMPOTENCY_LOOKUP_INVALID");
  }
  if (result.status === "found") {
    if (result.intent_digest !== binding.intent_digest ||
        !boundedOperationValue(result.backend_reference, 1024)) {
      fail("EG_IDEMPOTENCY_INTENT_MISMATCH");
    }
  } else if (result.intent_digest !== null ||
      result.backend_reference !== null) {
    fail("EG_IDEMPOTENCY_LOOKUP_INVALID");
  }
  return deepFreeze({
    outcome: result.status === "found" ? "matched" : result.status,
    backend_reference: result.backend_reference,
    evidence_digest: result.evidence_digest
  });
}
