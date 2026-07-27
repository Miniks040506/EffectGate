import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(readFileSync(
  join(HERE, "..", "..", "contracts", "policy.schema.json"),
  "utf8"
));
const digest = (character) => `sha256:${character.repeat(64)}`;

function fixture() {
  return {
    schema_version: "1.0.0",
    policy_id: "default",
    default_decision: "deny",
    rules: [{
      id: "allow-inspect",
      match: { effect_class: "observe" },
      decision: "allow"
    }, {
      id: "ask-modify",
      match: {
        skill_id: "document-editor",
        skill_digest: digest("a"),
        phase: "modify",
        phase_revision: 2,
        capsule_digest: digest("b"),
        capability_id: "filesystem.apply_patch",
        capability_revision: "patch-v1",
        effect_class: "mutate_reversible"
      },
      decision: "ask"
    }],
    compiler_version: "0.1.0",
    policy_revision: digest("c")
  };
}

function assertContract(value) {
  const allowed = new Set(Object.keys(CONTRACT.properties));
  assert.deepEqual(Object.keys(value).filter((key) => !allowed.has(key)), []);
  for (const key of CONTRACT.required) assert.ok(Object.hasOwn(value, key));
  assert.equal(value.schema_version, CONTRACT.properties.schema_version.const);
  assert.equal(value.default_decision,
    CONTRACT.properties.default_decision.const);
  const pattern = (definition, candidate) =>
    assert.match(candidate, new RegExp(definition.pattern, "u"));
  pattern(CONTRACT.$defs.name, value.policy_id);
  pattern(CONTRACT.$defs.version, value.compiler_version);
  pattern(CONTRACT.$defs.digest, value.policy_revision);
  assert.ok(value.rules.length >= CONTRACT.properties.rules.minItems);
  for (const rule of value.rules) {
    assert.deepEqual(
      Object.keys(rule).filter((key) => !["id", "match", "decision"].includes(key)),
      []
    );
    pattern(CONTRACT.$defs.name, rule.id);
    assert.ok(CONTRACT.$defs.decision.enum.includes(rule.decision));
    assert.ok(Object.keys(rule.match).length >= 1);
    const matchProperties = CONTRACT.$defs.match.properties;
    for (const [key, match] of Object.entries(rule.match)) {
      assert.ok(Object.hasOwn(matchProperties, key));
      if (key.endsWith("_digest")) pattern(CONTRACT.$defs.digest, match);
      if (key === "skill_id" || key === "phase") {
        pattern(CONTRACT.$defs.name, match);
      }
      if (key === "effect_class") {
        assert.ok(CONTRACT.$defs.effectClass.enum.includes(match));
      }
      if (key === "phase_revision") {
        assert.ok(Number.isSafeInteger(match));
        assert.ok(match >= matchProperties.phase_revision.minimum);
        assert.ok(match <= matchProperties.phase_revision.maximum);
      }
      if (key === "capability_id") {
        assert.ok(match.length >= 1 &&
          match.length <= CONTRACT.$defs.boundedString.maxLength);
      }
      if (key === "capability_revision") {
        assert.ok(match.length >= matchProperties[key].minLength &&
          match.length <= matchProperties[key].maxLength);
      }
    }
  }
}

test("Policy contract accepts exact phase-bound rules", () => {
  assert.equal(CONTRACT.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(CONTRACT.additionalProperties, false);
  assertContract(fixture());
});

test("Policy contract rejects unsafe boundary values", () => {
  const cases = [
    (value) => { value.extra = true; },
    (value) => { value.default_decision = "allow"; },
    (value) => { value.rules = []; },
    (value) => { value.rules[0].decision = "permit"; },
    (value) => { value.rules[1].match.phase_revision = 0; },
    (value) => { value.rules[1].match.capsule_digest = "not-a-digest"; },
    (value) => { value.rules[1].match.extra = true; }
  ];
  for (const mutate of cases) {
    const value = fixture();
    mutate(value);
    assert.throws(() => assertContract(value));
  }
});
