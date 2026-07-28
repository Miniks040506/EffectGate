import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { compileEffectIntent } from "../src/policy/effect-intent.mjs";
import {
  IdempotencyAdapterError,
  compileIdempotencyAdapter,
  deriveIdempotencyBinding,
  prepareIdempotentDispatch
} from "../src/policy/idempotency-adapter.mjs";
import { EffectOperationJournal } from "../src/policy/operation-journal.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const ARGUMENTS = {
  body: "MUST_NOT_ENTER_IDEMPOTENCY_DB",
  resource: "issue-123"
};

function intent(now, transactionId) {
  return compileEffectIntent({
    principalId: "principal-local",
    clientId: "effectgate-test",
    sessionId: "session-1",
    admission: {
      schema_version: "1.0.0",
      transaction_id: transactionId,
      skill_id: "issue-commenter",
      skill_digest: digest("a"),
      phase: "comment",
      phase_revision: 1,
      capsule_digest: digest("b"),
      capability_id: "comments.create",
      capability_revision: "comments-v1",
      effect_class: "external_commit"
    },
    policyDecision: {
      decision: "allow",
      policy_revision: digest("c"),
      matched_rule_ids: ["allow-comment"],
      safe_reason_code: "policy_allow"
    },
    arguments: ARGUMENTS,
    resourceScope: {
      kind: "exact",
      value: "issue:123"
    },
    disclosureDigest: digest("d"),
    expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
    now: () => now
  });
}

function adapter() {
  return compileIdempotencyAdapter({
    schema_version: "1.0.0",
    capability_id: "comments.create",
    capability_revision: "comments-v1",
    key_placement: {
      target: "arguments",
      name: "idempotency_key"
    },
    lookup: {
      capability_id: "comments.lookup_by_key",
      capability_revision: "lookup-v1",
      key_argument: "idempotency_key"
    },
    qualified_scenarios: [
      "same_key_same_intent",
      "same_key_different_intent",
      "concurrent_duplicate_calls",
      "server_restart",
      "response_loss_after_commit"
    ],
    qualification_evidence_digest: digest("e")
  });
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-idempotency-"));
  const clock = {
    wall: Date.parse("2026-07-28T00:00:00.000Z"),
    monotonic: 1000
  };
  const file = join(directory, "effectgate.db");
  return {
    directory,
    file,
    clock,
    journal: () => new EffectOperationJournal({
      file,
      now: () => clock.wall,
      monotonic: () => clock.monotonic
    }),
    close() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function admit(journal, operationId, operationIntent) {
  journal.plan({
    operationId,
    intent: operationIntent,
    approvalRequired: false
  });
  journal.preflight(operationId);
  return journal.admit(operationId);
}

function assertCode(code, action) {
  assert.throws(action, (error) =>
    error instanceof IdempotencyAdapterError && error.code === code);
}

test("dispatch persists only hashed idempotency binding and recovers its key", () => {
  const files = fixture();
  let journal = files.journal();
  try {
    const declaration = adapter();
    const admitted = admit(
      journal,
      "operation-idempotent",
      intent(files.clock.wall, "transaction-idempotent")
    );
    const prepared = prepareIdempotentDispatch({
      adapter: declaration,
      operation: admitted,
      request: { arguments: ARGUMENTS, headers: {} }
    });
    const deadlineAt = new Date(files.clock.wall + 30_000).toISOString();
    journal.beginDispatch({
      operationId: admitted.operation_id,
      dispatchDigest: prepared.dispatch_digest,
      deadlineAt,
      idempotency: prepared.idempotency
    });
    const executing = journal.load(admitted.operation_id).operation;
    assert.equal(executing.state, "executing");
    assert.equal(
      executing.idempotency.key_hash,
      prepared.idempotency.binding.key_hash
    );
    assert.equal(Object.hasOwn(executing.idempotency, "key"), false);
    assert.equal(executing.dispatch_digest, prepared.dispatch_digest);
    const stored = readdirSync(files.directory)
      .map((file) => readFileSync(join(files.directory, file)));
    assert.equal(stored.some((data) =>
      data.includes(prepared.idempotency.binding.key)), false);
    assert.equal(stored.some((data) =>
      data.includes("MUST_NOT_ENTER_IDEMPOTENCY_DB")), false);

    journal.close();
    journal = files.journal();
    const recovered = journal.load(admitted.operation_id).operation;
    const rebound = deriveIdempotencyBinding({
      adapter: declaration,
      operation: recovered
    });
    assert.equal(rebound.key, prepared.idempotency.binding.key);
    assert.equal(rebound.key_hash, recovered.idempotency.key_hash);

    const database = new DatabaseSync(files.file);
    assert.throws(() => database.prepare(`UPDATE operation_idempotency
      SET key_hash=? WHERE operation_id=?`).run(
      digest("f"), admitted.operation_id
    ));
    database.close();

    journal.close();
    const tamper = new DatabaseSync(files.file);
    tamper.exec("DROP TRIGGER operation_idempotency_no_update");
    tamper.prepare(`UPDATE operation_idempotency SET adapter_digest=?
      WHERE operation_id=?`).run(digest("f"), admitted.operation_id);
    tamper.close();
    journal = files.journal();
    assert.throws(
      () => journal.load(admitted.operation_id),
      (error) => error.code === "EG_OPERATION_CORRUPT"
    );
  } finally {
    try { journal.close(); } catch {}
    files.close();
  }
});

test("dispatch mismatch rolls back metadata and leaves admission reusable", () => {
  const files = fixture();
  const journal = files.journal();
  try {
    const declaration = adapter();
    const first = admit(
      journal,
      "operation-first",
      intent(files.clock.wall, "transaction-first")
    );
    const second = admit(
      journal,
      "operation-second",
      intent(files.clock.wall, "transaction-second")
    );
    const firstPrepared = prepareIdempotentDispatch({
      adapter: declaration,
      operation: first,
      request: { arguments: ARGUMENTS, headers: {} }
    });
    const deadlineAt = new Date(files.clock.wall + 30_000).toISOString();
    assertCode("EG_IDEMPOTENCY_DISPATCH_MISMATCH", () =>
      journal.beginDispatch({
        operationId: second.operation_id,
        dispatchDigest: digest("9"),
        deadlineAt,
        idempotency: firstPrepared.idempotency
      }));
    assert.equal(journal.load(second.operation_id).operation.state, "admitted");
    assert.equal(
      journal.load(second.operation_id).operation.idempotency,
      null
    );

    const secondPrepared = prepareIdempotentDispatch({
      adapter: declaration,
      operation: second,
      request: { arguments: ARGUMENTS, headers: {} }
    });
    journal.beginDispatch({
      operationId: second.operation_id,
      dispatchDigest: secondPrepared.dispatch_digest,
      deadlineAt,
      idempotency: secondPrepared.idempotency
    });
    assert.equal(
      journal.load(second.operation_id).operation.idempotency.key_hash,
      secondPrepared.idempotency.binding.key_hash
    );
  } finally {
    journal.close();
    files.close();
  }
});
