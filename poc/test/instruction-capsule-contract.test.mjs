import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(
  readFileSync(
    join(HERE, "..", "..", "contracts", "instruction-capsule.schema.json"),
    "utf8"
  )
);
const digest = (character) => `sha256:${character.repeat(64)}`;

function fixture() {
  return {
    schema_version: "1.0.0",
    capsule_id: "cap_0123456789abcdef",
    skill_id: "document-editor",
    skill_version: "1.4.0",
    skill_digest: digest("a"),
    phase: "modify",
    phase_revision: 1,
    invariants: [{
      id: "preserve-original",
      text: "Preserve the original until verification succeeds.",
      source_ref: "artifact://skill/SKILL.md#safety"
    }],
    instructions: [{
      id: "modify-main",
      text: "Apply the admitted change.",
      source_ref: "artifact://skill/phases/modify.md"
    }],
    allowed_tools: [{
      capability_id: "filesystem.apply_patch",
      capability_revision: "revision-1",
      effect_class: "mutate_reversible"
    }],
    transition_conditions: {
      success: "verification evidence is present",
      failure: "remain in modify or enter manual resolution"
    },
    budget: { max_tokens: 1200, max_bytes: 6000 },
    provenance: {
      compiler_version: "0.1.0",
      passport_digest: digest("b"),
      dependency_digests: [digest("c")]
    },
    capsule_digest: digest("d"),
    expires_at: "2026-07-28T00:00:00.000Z"
  };
}

function assertContract(value) {
  const allowed = new Set(Object.keys(CONTRACT.properties));
  assert.deepEqual(
    Object.keys(value).filter((key) => !allowed.has(key)),
    []
  );
  for (const key of CONTRACT.required) assert.ok(Object.hasOwn(value, key));
  assert.equal(value.schema_version, CONTRACT.properties.schema_version.const);

  const pattern = (definition, candidate) =>
    assert.match(candidate, new RegExp(definition.pattern, "u"));
  pattern(CONTRACT.properties.capsule_id, value.capsule_id);
  pattern(CONTRACT.$defs.name, value.skill_id);
  pattern(CONTRACT.$defs.version, value.skill_version);
  pattern(CONTRACT.$defs.digest, value.skill_digest);
  pattern(CONTRACT.$defs.name, value.phase);
  pattern(CONTRACT.$defs.digest, value.capsule_digest);
  assert.ok(Number.isSafeInteger(value.phase_revision));
  assert.ok(value.phase_revision >= 1 && value.instructions.length >= 1);
  assert.ok(value.budget.max_tokens >= 1 && value.budget.max_bytes >= 1);
  assert.ok(!Number.isNaN(Date.parse(value.expires_at)));

  for (const item of [...value.invariants, ...value.instructions]) {
    pattern(CONTRACT.$defs.name, item.id);
    assert.ok(item.text.length >= 1);
  }
  for (const tool of value.allowed_tools) {
    assert.ok(CONTRACT.$defs.effectClass.enum.includes(tool.effect_class));
  }
  pattern(CONTRACT.$defs.version, value.provenance.compiler_version);
  pattern(CONTRACT.$defs.digest, value.provenance.passport_digest);
  for (const valueDigest of value.provenance.dependency_digests) {
    pattern(CONTRACT.$defs.digest, valueDigest);
  }
}

test("Instruction Capsule contract accepts a bounded modify phase", () => {
  assert.equal(CONTRACT.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(CONTRACT.additionalProperties, false);
  assertContract(fixture());
});

test("Instruction Capsule contract rejects unsafe boundary values", () => {
  const cases = [
    (value) => { value.extra = true; },
    (value) => { value.capsule_id = "cap_short"; },
    (value) => { value.instructions = []; },
    (value) => { value.allowed_tools[0].effect_class = "filesystem_write"; },
    (value) => { value.budget.max_tokens = 0; },
    (value) => {
      value.provenance.dependency_digests = ["sha256:not-a-digest"];
    },
    (value) => { value.expires_at = "not-a-time"; }
  ];

  for (const mutate of cases) {
    const value = fixture();
    mutate(value);
    assert.throws(() => assertContract(value));
  }
});
