import assert from "node:assert/strict";
import test from "node:test";

import {
  compileEffectIntent,
  diffEffectIntents
} from "../src/policy/effect-intent.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const NOW = Date.parse("2026-07-28T00:00:00.000Z");

function fixture(overrides = {}) {
  const admission = {
    schema_version: "1.0.0",
    transaction_id: "skill-transaction",
    skill_id: "document-editor",
    skill_digest: digest("a"),
    phase: "modify",
    phase_revision: 2,
    capsule_digest: digest("b"),
    capability_id: "filesystem.apply_patch",
    capability_revision: "patch-v1",
    effect_class: "mutate_reversible",
    ...overrides.admission
  };
  const policyDecision = {
    decision: "ask",
    policy_revision: digest("c"),
    matched_rule_ids: ["ask-modify"],
    safe_reason_code: "policy_ask",
    ...overrides.policyDecision
  };
  return compileEffectIntent({
    principalId: "principal-local",
    clientId: "claude-code",
    sessionId: "session-1",
    admission,
    policyDecision,
    arguments: { patch: "café", count: 1, offset: 0 },
    resourceScope: {
      kind: "exact",
      value: "repo:owner/name/path:docs/guide.md"
    },
    disclosureDigest: digest("d"),
    expiresAt: "2026-07-28T00:05:00.000Z",
    now: () => NOW,
    ...Object.fromEntries(
      Object.entries(overrides).filter(
        ([key]) => !["admission", "policyDecision"].includes(key)
      )
    )
  });
}

test("effect intent is deterministic, normalized, and content-free", () => {
  const first = fixture();
  const second = fixture({
    arguments: {
      offset: -0,
      count: 1,
      patch: "cafe\u0301"
    }
  });
  assert.deepEqual(second, first);
  assert.match(first.intent_digest, /^sha256:[a-f0-9]{64}$/u);
  assert.match(first.canonical_arguments_hash, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(JSON.stringify(first).includes("café"), false);
  assert.ok(Object.isFrozen(first.resource_scope));
  assert.deepEqual(diffEffectIntents(first, second), {
    changed: false,
    invalidation_reasons: []
  });
});

test("effect intent reports stable material-change reasons", () => {
  const original = fixture();
  const cases = [
    [{ arguments: { patch: "different" } }, "arguments_changed"],
    [{
      resourceScope: {
        kind: "exact",
        value: "repo:owner/name/path:docs/other.md"
      }
    }, "target_changed"],
    [{
      resourceScope: { kind: "prefix", value: "repo:owner/name/path:docs/" }
    }, "scope_widened"],
    [{ admission: { capability_revision: "patch-v2" } },
      "capability_revision_changed"],
    [{ admission: { capsule_digest: digest("e") } }, "capsule_changed"],
    [{ admission: { phase: "verify" } }, "phase_changed"],
    [{ policyDecision: { policy_revision: digest("f") } },
      "policy_revision_changed"],
    [{ disclosureDigest: digest("0") }, "disclosure_changed"],
    [{ principalId: "principal-other" }, "principal_changed"],
    [{ expiresAt: "2026-07-28T00:06:00.000Z" }, "expiry_changed"]
  ];
  for (const [change, reason] of cases) {
    assert.ok(
      diffEffectIntents(original, fixture(change))
        .invalidation_reasons.includes(reason),
      reason
    );
  }
});

test("effect intent rejects unsafe or ambiguous inputs", () => {
  assert.throws(() => fixture({ policyDecision: { decision: "deny" } }),
    TypeError);
  assert.throws(() => fixture({
    expiresAt: "2026-07-28T00:00:00.000Z"
  }), TypeError);
  assert.throws(() => fixture({
    admission: { effect_class: "unknown" }
  }), TypeError);
  assert.throws(() => fixture({ arguments: { value: Number.NaN } }),
    TypeError);
  assert.throws(() => fixture({ arguments: { value: undefined } }),
    TypeError);
  assert.throws(() => fixture({
    arguments: JSON.parse('{"é":1,"é":2}')
  }), TypeError);
  const cycle = {};
  cycle.self = cycle;
  assert.throws(() => fixture({ arguments: cycle }), TypeError);
  const sparse = [];
  sparse.length = 1;
  assert.throws(() => fixture({ arguments: { sparse } }), TypeError);
  const accessor = {};
  Object.defineProperty(accessor, "value", {
    enumerable: true,
    get: () => "unstable"
  });
  assert.throws(() => fixture({ arguments: accessor }), TypeError);
  const intent = fixture();
  assert.throws(() => diffEffectIntents(
    { ...intent, policy_revision: digest("9") },
    intent
  ), TypeError);
  assert.throws(() => compileEffectIntent({
    extra: true
  }), TypeError);
});
