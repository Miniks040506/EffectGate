import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(
  readFileSync(
    join(HERE, "..", "..", "contracts", "phase-receipt.schema.json"),
    "utf8"
  )
);
const digest = (character) => `sha256:${character.repeat(64)}`;

function fixture() {
  return {
    schema_version: "1.0.0",
    skill_id: "document-editor",
    skill_digest: digest("a"),
    phase: "inspect",
    capsule_digest: digest("b"),
    status: "completed",
    input_artifact_digests: [digest("c")],
    finding_refs: ["artifact://findings/inspect"],
    effect_receipt_refs: [],
    next_phase: "modify"
  };
}

function assertUnique(values) {
  assert.equal(new Set(values).size, values.length);
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
  pattern(CONTRACT.$defs.name, value.skill_id);
  pattern(CONTRACT.$defs.digest, value.skill_digest);
  pattern(CONTRACT.$defs.name, value.phase);
  pattern(CONTRACT.$defs.digest, value.capsule_digest);
  assert.ok(CONTRACT.properties.status.enum.includes(value.status));

  assertUnique(value.input_artifact_digests);
  assertUnique(value.finding_refs);
  assertUnique(value.effect_receipt_refs);
  for (const artifactDigest of value.input_artifact_digests) {
    pattern(CONTRACT.$defs.digest, artifactDigest);
  }
  for (const reference of [
    ...value.finding_refs,
    ...value.effect_receipt_refs
  ]) {
    assert.ok(reference.length >= 1 && reference.length <= 1024);
  }
  if (value.next_phase !== null) pattern(CONTRACT.$defs.name, value.next_phase);
}

test("Phase Receipt contract accepts progressing and terminal phases", () => {
  assert.equal(CONTRACT.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(CONTRACT.additionalProperties, false);
  assertContract(fixture());
  assertContract({ ...fixture(), phase: "verify", next_phase: null });
});

test("Phase Receipt contract rejects unsafe boundary values", () => {
  const cases = [
    (value) => { value.extra = true; },
    (value) => { value.skill_digest = "sha256:not-a-digest"; },
    (value) => { value.phase = "../inspect"; },
    (value) => { value.status = "uncertain"; },
    (value) => {
      value.input_artifact_digests.push(value.input_artifact_digests[0]);
    },
    (value) => { value.finding_refs = [""]; },
    (value) => { value.next_phase = "../modify"; }
  ];

  for (const mutate of cases) {
    const value = fixture();
    mutate(value);
    assert.throws(() => assertContract(value));
  }
});
