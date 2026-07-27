import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(
  readFileSync(
    join(HERE, "..", "..", "contracts", "skill-passport.schema.json"),
    "utf8"
  )
);

const digest = (character) => `sha256:${character.repeat(64)}`;

function fixture() {
  return {
    schema_version: "1.0.0",
    skill: {
      id: "document-editor",
      version: "1.4.0",
      source_digest: digest("a"),
      trust_tier: "local_reviewed"
    },
    invariants: [{
      id: "preserve-original",
      source_ref: "SKILL.md#safety",
      pin: "transaction",
      class: "safety"
    }],
    phases: {
      inspect: {
        instruction_refs: ["phases/inspect.md"],
        dependency_refs: ["references/file-types.md"],
        allowed_tools: ["filesystem.read"],
        allowed_effect_classes: ["observe"],
        transition: { on_success: "modify" }
      },
      modify: {
        instruction_refs: ["phases/modify.md"],
        allowed_tools: ["filesystem.apply_patch"],
        allowed_effect_classes: ["mutate_reversible"],
        transition: { on_success: "verify", on_failure: "modify" }
      },
      verify: {
        instruction_refs: ["phases/verify.md"],
        allowed_tools: ["renderer.preview"],
        allowed_effect_classes: ["observe"]
      }
    },
    compiler_version: "0.1.0",
    passport_digest: digest("b")
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
  pattern(CONTRACT.$defs.name, value.skill.id);
  pattern(CONTRACT.$defs.version, value.skill.version);
  pattern(CONTRACT.$defs.digest, value.skill.source_digest);
  pattern(CONTRACT.$defs.version, value.compiler_version);
  pattern(CONTRACT.$defs.digest, value.passport_digest);
  assert.ok(
    CONTRACT.$defs.skill.properties.trust_tier.enum.includes(
      value.skill.trust_tier
    )
  );

  for (const invariant of value.invariants) {
    pattern(CONTRACT.$defs.name, invariant.id);
    assert.equal(invariant.pin, "transaction");
    assert.ok(
      CONTRACT.$defs.invariant.properties.class.enum.includes(invariant.class)
    );
  }
  for (const [name, phase] of Object.entries(value.phases)) {
    pattern(CONTRACT.$defs.name, name);
    assert.ok(phase.instruction_refs.length > 0);
    for (const effect of phase.allowed_effect_classes) {
      assert.ok(CONTRACT.$defs.effectClass.enum.includes(effect));
    }
    for (const target of Object.values(phase.transition ?? {})) {
      pattern(CONTRACT.$defs.name, target);
    }
  }
}

test("Skill Passport contract accepts the seeded three-phase shape", () => {
  assert.equal(CONTRACT.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(CONTRACT.additionalProperties, false);
  assertContract(fixture());
});

test("Skill Passport contract rejects unsafe boundary values", () => {
  const cases = [
    { key: "unknown root field", mutate: (value) => { value.extra = true; } },
    { key: "weak digest", mutate: (value) => {
      value.skill.source_digest = "sha256:not-a-digest";
    } },
    { key: "unpinned invariant", mutate: (value) => {
      value.invariants[0].pin = "phase";
    } },
    { key: "unknown effect", mutate: (value) => {
      value.phases.modify.allowed_effect_classes = ["filesystem_write"];
    } },
    { key: "invalid transition name", mutate: (value) => {
      value.phases.inspect.transition.on_success = "../modify";
    } }
  ];

  for (const example of cases) {
    const value = fixture();
    example.mutate(value);
    assert.throws(() => assertContract(value), undefined, example.key);
  }
});
