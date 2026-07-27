import assert from "node:assert/strict";
import test from "node:test";

import {
  compilePolicy,
  evaluatePolicy
} from "../src/policy/policy-compiler.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const request = {
  skill_id: "document-editor",
  skill_digest: digest("a"),
  phase: "modify",
  phase_revision: 2,
  capsule_digest: digest("b"),
  capability_id: "filesystem.apply_patch",
  capability_revision: "patch-v1",
  effect_class: "mutate_reversible"
};
const bound = (id, decision, overrides = {}) => ({
  id,
  match: { ...request, ...overrides },
  decision
});

test("policy compilation is deterministic and deny overrides admission", () => {
  const rules = [
    bound("allow-modify", "allow"),
    bound("ask-modify", "ask"),
    {
      id: "allow-observe",
      match: { effect_class: "observe" },
      decision: "allow"
    }
  ];
  const policy = compilePolicy({ policyId: "default", rules });
  assert.deepEqual(
    compilePolicy({ policyId: "default", rules: [...rules].reverse() }),
    policy
  );
  assert.match(policy.policy_revision, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(Object.isFrozen(policy.rules[0].match));

  assert.deepEqual(evaluatePolicy(policy, request), {
    decision: "ask",
    policy_revision: policy.policy_revision,
    matched_rule_ids: ["allow-modify", "ask-modify"],
    safe_reason_code: "policy_ask"
  });
  assert.equal(evaluatePolicy(policy, {
    schema_version: "1.0.0",
    transaction_id: "skill-transaction",
    ...request
  }).decision, "ask");
  const denied = compilePolicy({
    policyId: "default",
    rules: [...rules, bound("deny-modify", "deny")]
  });
  assert.deepEqual(evaluatePolicy(denied, request), {
    decision: "deny",
    policy_revision: denied.policy_revision,
    matched_rule_ids: ["allow-modify", "ask-modify", "deny-modify"],
    safe_reason_code: "policy_deny"
  });

  const observed = { ...request, effect_class: "observe" };
  assert.equal(evaluatePolicy(policy, observed).decision, "allow");
});

test("policy evaluation fails closed on drift, unknowns, and bad policy", () => {
  const policy = compilePolicy({
    policyId: "default",
    rules: [bound("ask-modify", "ask")]
  });
  for (const change of [
    { skill_digest: digest("c") },
    { phase: "verify" },
    { phase_revision: 3 },
    { capsule_digest: digest("d") },
    { capability_revision: "patch-v2" }
  ]) {
    const result = evaluatePolicy(policy, { ...request, ...change });
    assert.equal(result.decision, "deny");
    assert.equal(result.safe_reason_code, "policy_default_deny");
  }
  assert.equal(
    evaluatePolicy(policy, { ...request, effect_class: "unknown" })
      .safe_reason_code,
    "unknown_effect"
  );
  assert.equal(evaluatePolicy(undefined, request).safe_reason_code,
    "policy_unavailable");
  assert.equal(evaluatePolicy(
    { ...policy, policy_revision: digest("0") },
    request
  ).safe_reason_code, "policy_unavailable");
  assert.equal(evaluatePolicy(policy, { ...request, phase_revision: 0 })
    .safe_reason_code, "invalid_admission");
});

test("policy compiler rejects ambiguous or unsafe protected rules", () => {
  const cases = [
    [bound("duplicate", "ask"), bound("duplicate", "deny")],
    [{
      id: "broad-protected",
      match: { effect_class: "mutate_reversible" },
      decision: "ask"
    }],
    [{
      id: "allow-unknown",
      match: { effect_class: "unknown" },
      decision: "allow"
    }],
    [bound("extra", "ask", { extra: true })]
  ];
  for (const rules of cases) {
    assert.throws(() => compilePolicy({ policyId: "default", rules }),
      TypeError);
  }
  assert.throws(() => compilePolicy({
    policyId: "default",
    rules: [bound("ask-modify", "ask")],
    extra: true
  }), TypeError);
});
