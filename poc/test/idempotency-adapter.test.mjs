import assert from "node:assert/strict";
import test from "node:test";

import { canonicalArgumentsHash } from "../src/policy/effect-intent.mjs";
import {
  IdempotencyAdapterError,
  buildIdempotencyLookup,
  compileIdempotencyAdapter,
  prepareIdempotentDispatch,
  validateIdempotencyLookup,
  verifyIdempotencyAdapter
} from "../src/policy/idempotency-adapter.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const SCENARIOS = [
  "same_key_same_intent",
  "same_key_different_intent",
  "concurrent_duplicate_calls",
  "server_restart",
  "response_loss_after_commit"
];

function declaration(target = "arguments") {
  return {
    schema_version: "1.0.0",
    capability_id: "comments.create",
    capability_revision: "comments-v1",
    key_placement: {
      target,
      name: target === "headers"
        ? "Idempotency-Key"
        : "idempotency_key"
    },
    lookup: {
      capability_id: "comments.lookup_by_key",
      capability_revision: "lookup-v1",
      key_argument: "idempotency_key"
    },
    qualified_scenarios: [...SCENARIOS],
    qualification_evidence_digest: digest("a")
  };
}

function operation(argumentsValue = { body: "hello" }, overrides = {}) {
  return {
    schema_version: "1.0.0",
    operation_id: "operation-1",
    intent_digest: digest("b"),
    canonical_arguments_hash: canonicalArgumentsHash(argumentsValue),
    capability_id: "comments.create",
    capability_revision: "comments-v1",
    state: "admitted",
    ...overrides
  };
}

function assertCode(code, action) {
  assert.throws(action, (error) =>
    error instanceof IdempotencyAdapterError && error.code === code);
}

test("idempotency adapter requires every qualified failure scenario", () => {
  const adapter = compileIdempotencyAdapter(declaration());
  assert.match(adapter.adapter_digest, /^sha256:[a-f0-9]{64}$/u);
  assert.deepEqual(adapter.qualified_scenarios, SCENARIOS);
  assert.ok(Object.isFrozen(adapter.key_placement));
  assert.equal(verifyIdempotencyAdapter(adapter), adapter);
  assert.deepEqual(
    compileIdempotencyAdapter({
      ...declaration(),
      qualified_scenarios: [...SCENARIOS].reverse()
    }),
    adapter
  );

  const cases = [
    { ...declaration(), extra: true },
    {
      ...declaration(),
      qualified_scenarios: SCENARIOS.slice(0, -1)
    },
    {
      ...declaration(),
      key_placement: { target: "body", name: "idempotency_key" }
    },
    {
      ...declaration(),
      lookup: {
        ...declaration().lookup,
        key_argument: "../idempotency_key"
      }
    },
    {
      ...declaration(),
      qualification_evidence_digest: "unqualified"
    }
  ];
  for (const value of cases) {
    assertCode("EG_IDEMPOTENCY_CONTRACT_INVALID", () =>
      compileIdempotencyAdapter(value));
  }
  assertCode("EG_IDEMPOTENCY_CONTRACT_INVALID", () =>
    verifyIdempotencyAdapter({
      ...adapter,
      capability_revision: "comments-v2"
    }));
});

test("runtime injects one operation-bound key without mutating arguments", () => {
  const adapter = compileIdempotencyAdapter(declaration());
  const argumentsValue = { body: "hello", nested: { count: 1 } };
  const admitted = operation(argumentsValue);
  const request = { arguments: argumentsValue, headers: {} };
  const first = prepareIdempotentDispatch({
    adapter,
    operation: admitted,
    request
  });
  const second = prepareIdempotentDispatch({
    adapter,
    operation: admitted,
    request
  });
  assert.match(first.idempotency.binding.key, /^eg_[A-Za-z0-9_-]{43}$/u);
  assert.equal(first.idempotency.binding.key,
    second.idempotency.binding.key);
  assert.equal(first.dispatch_digest, second.dispatch_digest);
  assert.equal(Object.hasOwn(argumentsValue, "idempotency_key"), false);
  assert.equal(
    first.request.arguments.idempotency_key,
    first.idempotency.binding.key
  );
  assert.notEqual(
    prepareIdempotentDispatch({
      adapter,
      operation: operation(argumentsValue, {
        operation_id: "operation-2"
      }),
      request
    }).idempotency.binding.key,
    first.idempotency.binding.key
  );

  const headerAdapter = compileIdempotencyAdapter(
    declaration("headers")
  );
  const header = prepareIdempotentDispatch({
    adapter: headerAdapter,
    operation: admitted,
    request: { arguments: argumentsValue, headers: { Accept: "text/plain" } }
  });
  assert.equal(
    header.request.headers["Idempotency-Key"],
    header.idempotency.binding.key
  );
  assert.equal(header.request.arguments.idempotency_key, undefined);

  assertCode("EG_IDEMPOTENCY_KEY_CONFLICT", () =>
    prepareIdempotentDispatch({
      adapter,
      operation: admitted,
      request: {
        arguments: { ...argumentsValue, idempotency_key: "model-value" },
        headers: {}
      }
    }));
  assertCode("EG_IDEMPOTENCY_OPERATION_MISMATCH", () =>
    prepareIdempotentDispatch({
      adapter,
      operation: admitted,
      request: { arguments: { body: "changed" }, headers: {} }
    }));
  assertCode("EG_IDEMPOTENCY_OPERATION_MISMATCH", () =>
    prepareIdempotentDispatch({
      adapter,
      operation: { ...admitted, capability_revision: "comments-v2" },
      request
    }));
});

test("lookup accepts an exact match and rejects key or intent drift", () => {
  const adapter = compileIdempotencyAdapter(declaration());
  const prepared = prepareIdempotentDispatch({
    adapter,
    operation: operation(),
    request: { arguments: { body: "hello" }, headers: {} }
  });
  const { binding } = prepared.idempotency;
  assert.deepEqual(buildIdempotencyLookup({
    adapter,
    binding
  }), {
    capability_id: "comments.lookup_by_key",
    capability_revision: "lookup-v1",
    arguments: { idempotency_key: binding.key }
  });
  const evidence = digest("c");
  assert.deepEqual(validateIdempotencyLookup({
    adapter,
    binding,
    result: {
      status: "found",
      idempotency_key: binding.key,
      intent_digest: binding.intent_digest,
      backend_reference: "comment://123",
      evidence_digest: evidence
    }
  }), {
    outcome: "matched",
    backend_reference: "comment://123",
    evidence_digest: evidence
  });
  for (const status of ["not_found", "ambiguous"]) {
    assert.equal(validateIdempotencyLookup({
      adapter,
      binding,
      result: {
        status,
        idempotency_key: binding.key,
        intent_digest: null,
        backend_reference: null,
        evidence_digest: evidence
      }
    }).outcome, status);
  }
  assertCode("EG_IDEMPOTENCY_INTENT_MISMATCH", () =>
    validateIdempotencyLookup({
      adapter,
      binding,
      result: {
        status: "found",
        idempotency_key: binding.key,
        intent_digest: digest("d"),
        backend_reference: "comment://other",
        evidence_digest: evidence
      }
    }));
  assertCode("EG_IDEMPOTENCY_LOOKUP_INVALID", () =>
    validateIdempotencyLookup({
      adapter,
      binding,
      result: {
        status: "found",
        idempotency_key: `eg_${"A".repeat(43)}`,
        intent_digest: binding.intent_digest,
        backend_reference: "comment://123",
        evidence_digest: evidence
      }
    }));
});
