import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(readFileSync(join(
  HERE, "..", "..", "contracts", "effect-receipt.schema.json"
), "utf8"));
const digest = (character) => `sha256:${character.repeat(64)}`;

function fixture() {
  return {
    schema_version: "1.0.0",
    receipt_id: "receipt-1",
    operation_id: "operation-1",
    principal_id: "principal-local",
    client_id: "effectgate-test",
    session_id: "session-1",
    transaction_id: "transaction-1",
    skill_id: "comment-editor",
    skill_digest: digest("a"),
    phase: "modify",
    phase_revision: 1,
    capsule_digest: digest("b"),
    capability_id: "comments.create",
    capability_revision: "comments-v1",
    effect_class: "external_commit",
    intent_digest: digest("c"),
    canonical_arguments_hash: digest("d"),
    resource_scope_digest: digest("e"),
    disclosure_digest: digest("f"),
    policy_revision: digest("1"),
    approval_proof_digest: null,
    dispatch_digest: digest("2"),
    idempotency_key_digest: null,
    safe_summary: "external_commit:verified_committed",
    verification_evidence_digest: digest("3"),
    final_state: "verified_committed",
    certainty: "verified_committed",
    event_chain_head: digest("4"),
    operation_created_at: "2026-07-28T00:00:00.000Z",
    finalized_at: "2026-07-28T00:00:01.000Z",
    issued_at: "2026-07-28T00:00:02.000Z",
    previous_receipt_hash: null,
    signer_key_id: "local-ed25519-1",
    signature: "YWJj",
    receipt_hash: digest("5")
  };
}

function assertContract(value) {
  const keys = Object.keys(CONTRACT.properties);
  assert.deepEqual(
    Object.keys(value).filter((key) => !keys.includes(key)),
    []
  );
  for (const key of CONTRACT.required) assert.ok(Object.hasOwn(value, key));
  const pattern = (definition, candidate) =>
    assert.match(candidate, new RegExp(definition.pattern, "u"));
  pattern(CONTRACT.$defs.identifier, value.receipt_id);
  pattern(CONTRACT.$defs.identifier, value.operation_id);
  for (const key of [
    "skill_digest", "capsule_digest", "intent_digest",
    "canonical_arguments_hash", "resource_scope_digest",
    "disclosure_digest", "policy_revision", "dispatch_digest",
    "verification_evidence_digest", "event_chain_head", "receipt_hash"
  ]) {
    pattern(CONTRACT.$defs.digest, value[key]);
  }
  for (const key of [
    "approval_proof_digest", "idempotency_key_digest",
    "previous_receipt_hash"
  ]) {
    if (value[key] !== null) pattern(CONTRACT.$defs.digest, value[key]);
  }
  assert.ok(CONTRACT.properties.effect_class.enum.includes(
    value.effect_class
  ));
  assert.ok(CONTRACT.properties.final_state.enum.includes(value.final_state));
  assert.ok(CONTRACT.properties.certainty.enum.includes(value.certainty));
  assert.ok(value.safe_summary.length >= 1 &&
    value.safe_summary.length <= 256);
  for (const key of [
    "operation_created_at", "finalized_at", "issued_at"
  ]) {
    assert.equal(new Date(value[key]).toISOString(), value[key]);
  }
  assert.equal(value.signer_key_id === null, value.signature === null);
  if (value.signature !== null) {
    assert.match(value.signature, /^[A-Za-z0-9_-]+$/u);
  }
}

test("Effect Receipt contract accepts signed and unsigned receipts", () => {
  assert.equal(CONTRACT.$schema, "https://json-schema.org/draft/2020-12/schema");
  assert.equal(CONTRACT.additionalProperties, false);
  assertContract(fixture());
  assertContract({
    ...fixture(),
    final_state: "manual_resolution",
    certainty: "commit_possible",
    signer_key_id: null,
    signature: null
  });
});

test("Effect Receipt contract rejects unsafe boundary values", () => {
  const cases = [
    (value) => { value.raw_arguments = { token: "secret" }; },
    (value) => { value.receipt_id = "../receipt"; },
    (value) => { value.intent_digest = "sha256:not-a-digest"; },
    (value) => { value.effect_class = "unknown"; },
    (value) => { value.safe_summary = ""; },
    (value) => { value.final_state = "executing"; },
    (value) => { value.signature = "not base64url!"; },
    (value) => { value.signer_key_id = null; }
  ];
  for (const mutate of cases) {
    const value = fixture();
    mutate(value);
    assert.throws(() => assertContract(value));
  }
});
