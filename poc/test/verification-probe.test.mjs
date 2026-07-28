import assert from "node:assert/strict";
import test from "node:test";

import { canonicalArgumentsHash } from "../src/policy/effect-intent.mjs";
import {
  compileIdempotencyAdapter,
  deriveIdempotencyBinding
} from "../src/policy/idempotency-adapter.mjs";
import {
  VerificationProbeError,
  compileVerificationProbe,
  runVerificationProbe,
  verifyVerificationProbe
} from "../src/policy/verification-probe.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

function declaration(kind = "lookup_by_fingerprint", overrides = {}) {
  const sources = {
    lookup_by_idempotency_key: {
      name: "idempotency_key",
      source: "idempotency_key"
    },
    lookup_by_fingerprint: {
      name: "fingerprint",
      source: "canonical_arguments_hash"
    },
    read_after_write: {
      name: "resource",
      source: "resource_scope_value"
    },
    resource_version_match: {
      name: "resource",
      source: "resource_scope_value"
    }
  };
  return {
    schema_version: "1.0.0",
    capability_id: "comments.create",
    capability_revision: "comments-v1",
    kind,
    probe: {
      capability_id: kind === "lookup_by_idempotency_key"
        ? "comments.lookup_by_key"
        : "comments.lookup",
      capability_revision: "lookup-v1",
      effect_class: "observe"
    },
    arguments: [sources[kind]],
    predicates: {
      committed: [
        { path: "/status", equals: { literal: "found" } },
        {
          path: "/intent_digest",
          equals: { source: "intent_digest" }
        }
      ],
      not_committed: [
        { path: "/status", equals: { literal: "not_found" } }
      ],
      ambiguous: [
        { path: "/status", equals: { literal: "ambiguous" } }
      ]
    },
    limits: {
      max_attempts: 2,
      per_attempt_timeout_ms: 50,
      total_timeout_ms: 100,
      max_result_bytes: 4096,
      initial_backoff_ms: 10,
      max_backoff_ms: 10,
      observation_window_ms: 10,
      ...overrides.limits
    },
    evidence: {
      trust_level: "qualified_probe",
      redaction: "digest_only"
    },
    qualification_evidence_digest: digest("a"),
    ...Object.fromEntries(Object.entries(overrides)
      .filter(([key]) => key !== "limits"))
  };
}

function operation(overrides = {}) {
  return {
    schema_version: "1.0.0",
    operation_id: "operation-1",
    intent_digest: digest("b"),
    canonical_arguments_hash: canonicalArgumentsHash({ body: "hello" }),
    capability_id: "comments.create",
    capability_revision: "comments-v1",
    transaction_id: "transaction-1",
    resource_scope: { kind: "exact", value: "comment://123" },
    state: "uncertain",
    ...overrides
  };
}

function result(data, character = "c") {
  return {
    data,
    evidence_ref: `evidence://probe/${character}`,
    evidence_digest: digest(character)
  };
}

function assertCode(code, action) {
  assert.throws(action, (error) =>
    error instanceof VerificationProbeError && error.code === code);
}

test("verification descriptor is strict, canonical, and revision-bound", () => {
  const compiled = compileVerificationProbe(declaration());
  assert.match(compiled.descriptor_digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(verifyVerificationProbe(compiled), compiled);
  assert.ok(Object.isFrozen(compiled.predicates.committed));
  assert.deepEqual(
    compileVerificationProbe({
      ...declaration(),
      predicates: {
        ...declaration().predicates,
        committed: [...declaration().predicates.committed].reverse()
      }
    }),
    compiled
  );

  const invalid = [
    { ...declaration(), extra: true },
    {
      ...declaration(),
      probe: { ...declaration().probe, effect_class: "external_commit" }
    },
    {
      ...declaration(),
      probe: {
        ...declaration().probe,
        capability_id: "comments.create"
      }
    },
    {
      ...declaration(),
      arguments: [{ name: "resource", source: "resource_scope_value" }]
    },
    {
      ...declaration(),
      limits: { ...declaration().limits, max_attempts: 11 }
    }
  ];
  for (const value of invalid) {
    assertCode("EG_VERIFICATION_CONTRACT_INVALID", () =>
      compileVerificationProbe(value));
  }
  assertCode("EG_VERIFICATION_CONTRACT_INVALID", () =>
    verifyVerificationProbe({
      ...compiled,
      capability_revision: "comments-v2"
    }));
});

test("probe derives arguments from intent and retains digest-only evidence", async () => {
  const descriptor = compileVerificationProbe(declaration());
  const uncertain = operation();
  let request;
  const run = await runVerificationProbe({
    descriptor,
    operation: uncertain,
    invoke: async (value) => {
      request = value;
      return result({
        status: "found",
        intent_digest: uncertain.intent_digest,
        secret: "sentinel-must-not-escape"
      });
    },
    now: () => 0
  });
  assert.deepEqual(request, {
    capability_id: "comments.lookup",
    capability_revision: "lookup-v1",
    effect_class: "observe",
    arguments: {
      fingerprint: uncertain.canonical_arguments_hash
    }
  });
  assert.equal(run.outcome, "verified_committed");
  assert.equal(run.attempts.length, 1);
  assert.equal(run.attempts[0].evidence_ref, "evidence://probe/c");
  assert.equal(JSON.stringify(run).includes("sentinel-must-not-escape"), false);
  assert.match(run.evidence_digest, /^sha256:[a-f0-9]{64}$/u);

  const readRequests = [];
  await runVerificationProbe({
    descriptor: compileVerificationProbe(declaration("read_after_write")),
    operation: uncertain,
    invoke: async (value) => {
      readRequests.push(value);
      return result({
        status: "found",
        intent_digest: uncertain.intent_digest
      });
    },
    now: () => 0
  });
  assert.deepEqual(
    readRequests[0].arguments,
    { resource: uncertain.resource_scope.value }
  );
});

test("not-committed requires the observation window and bounded backoff", async () => {
  const descriptor = compileVerificationProbe(declaration());
  let clock = 0;
  const sleeps = [];
  const run = await runVerificationProbe({
    descriptor,
    operation: operation(),
    invoke: async () => result({ status: "not_found" }),
    now: () => clock,
    sleep: async (milliseconds) => {
      sleeps.push(milliseconds);
      clock += milliseconds;
    }
  });
  assert.equal(run.outcome, "verified_not_committed");
  assert.deepEqual(sleeps, [10]);
  assert.deepEqual(
    run.attempts.map(({ classification, safe_reason_code }) => ({
      classification,
      safe_reason_code
    })),
    [
      {
        classification: "ambiguous",
        safe_reason_code: "observation_window_open"
      },
      {
        classification: "not_committed",
        safe_reason_code: "not_committed_predicate_matched"
      }
    ]
  );
  assert.equal(run.observation_window_satisfied, true);
});
