import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  verifyEffectReceipt
} from "../src/policy/effect-receipt.mjs";
import { compileEffectIntent } from "../src/policy/effect-intent.mjs";
import {
  compileIdempotencyAdapter,
  prepareIdempotentDispatch
} from "../src/policy/idempotency-adapter.mjs";
import {
  EffectOperationJournal,
  OperationJournalError
} from "../src/policy/operation-journal.mjs";
import {
  compileVerificationProbe
} from "../src/policy/verification-probe.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;
const SECRET_BODY = "RECEIPT_MUST_NOT_CONTAIN_SECRET_BODY";
const PRIVATE_SCOPE = "comment://PRIVATE_RECEIPT_TARGET";

function intent(now, transactionId) {
  return compileEffectIntent({
    principalId: "principal-local",
    clientId: "effectgate-test",
    sessionId: "session-1",
    admission: {
      schema_version: "1.0.0",
      transaction_id: transactionId,
      skill_id: "comment-editor",
      skill_digest: digest("a"),
      phase: "modify",
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
    arguments: { body: SECRET_BODY },
    resourceScope: { kind: "exact", value: PRIVATE_SCOPE },
    disclosureDigest: digest("d"),
    expiresAt: new Date(now + 600_000).toISOString(),
    now: () => now
  });
}

function adapter() {
  return compileIdempotencyAdapter({
    schema_version: "1.0.0",
    capability_id: "comments.create",
    capability_revision: "comments-v1",
    key_placement: { target: "arguments", name: "idempotency_key" },
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

function probe() {
  return compileVerificationProbe({
    schema_version: "1.0.0",
    capability_id: "comments.create",
    capability_revision: "comments-v1",
    kind: "lookup_by_fingerprint",
    probe: {
      capability_id: "comments.lookup",
      capability_revision: "lookup-v1",
      effect_class: "observe"
    },
    arguments: [{
      name: "fingerprint",
      source: "canonical_arguments_hash"
    }],
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
      max_attempts: 1,
      per_attempt_timeout_ms: 50,
      total_timeout_ms: 1000,
      max_result_bytes: 4096,
      initial_backoff_ms: 10,
      max_backoff_ms: 10,
      observation_window_ms: 0
    },
    evidence: {
      trust_level: "qualified_probe",
      redaction: "digest_only"
    },
    qualification_evidence_digest: digest("f")
  });
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-receipt-"));
  const clock = {
    wall: Date.parse("2026-07-28T00:00:00.000Z"),
    monotonic: 1000
  };
  const file = join(directory, "effectgate.db");
  return {
    file,
    clock,
    journal: () => new EffectOperationJournal({
      file,
      now: () => clock.wall,
      monotonic: () => clock.monotonic
    }),
    close: () => rmSync(directory, { recursive: true, force: true })
  };
}

function admit(journal, files, operationId, transactionId) {
  journal.plan({
    operationId,
    intent: intent(files.clock.wall, transactionId),
    approvalRequired: false
  });
  journal.preflight(operationId);
  return journal.admit(operationId);
}

function makeUncertain(
  journal, files, operationId, transactionId, idempotent = false
) {
  const admitted = admit(journal, files, operationId, transactionId);
  let dispatchDigest = digest("1");
  let idempotency = null;
  let rawKey = null;
  if (idempotent) {
    const prepared = prepareIdempotentDispatch({
      adapter: adapter(),
      operation: admitted,
      request: {
        arguments: { body: SECRET_BODY },
        headers: {}
      }
    });
    dispatchDigest = prepared.dispatch_digest;
    idempotency = prepared.idempotency;
    rawKey = prepared.request.arguments.idempotency_key;
  }
  journal.beginDispatch({
    operationId,
    dispatchDigest,
    deadlineAt: new Date(files.clock.wall + 30_000).toISOString(),
    idempotency
  });
  const operation = journal.markUncertain({
    operationId,
    certainty: "commit_possible",
    evidenceRef: digest("2"),
    reason: "response_lost_after_dispatch"
  });
  return { operation, rawKey };
}

const hasCode = (code) => (error) =>
  error instanceof OperationJournalError && error.code === code;

test("terminal effects issue redacted, signed, chained receipts", async () => {
  const files = fixture();
  let journal = files.journal();
  try {
    const pending = admit(
      journal, files, "operation-pending", "transaction-pending"
    );
    assert.throws(() => journal.issueReceipt({
      receiptId: "receipt-pending",
      operationId: pending.operation_id
    }), hasCode("EG_RECEIPT_NOT_READY"));

    const { operation: uncertain, rawKey } = makeUncertain(
      journal, files, "operation-committed", "transaction-committed", true
    );
    const completed = await journal.reconcile({
      operationId: uncertain.operation_id,
      descriptor: probe(),
      invoke: async () => ({
        data: {
          status: "found",
          intent_digest: uncertain.intent_digest,
          secret: "PROBE_RESULT_MUST_NOT_ENTER_RECEIPT"
        },
        evidence_ref: "evidence://receipt/committed",
        evidence_digest: digest("3")
      }),
      probeNow: () => 0
    });
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const signed = journal.issueReceipt({
      receiptId: "receipt-committed",
      operationId: completed.operation_id,
      signer: { keyId: "local-ed25519-1", privateKey }
    });
    assert.equal(signed.final_state, "verified_committed");
    assert.equal(signed.intent_digest, completed.intent_digest);
    assert.equal(signed.event_chain_head, completed.last_event_digest);
    assert.equal(
      signed.verification_evidence_digest,
      completed.reconciliation.outcome.outcome_digest
    );
    assert.equal(
      signed.idempotency_key_digest,
      completed.idempotency.key_hash
    );
    assert.equal(verifyEffectReceipt(signed, {
      publicKey,
      signerKeyId: "local-ed25519-1"
    }), true);
    assert.equal(verifyEffectReceipt(signed, { signerKeyId: "wrong" }), false);
    const otherKey = generateKeyPairSync("ed25519").publicKey;
    assert.equal(verifyEffectReceipt(signed, { publicKey: otherKey }), false);
    assert.equal(Object.isFrozen(signed), true);

    const direct = makeUncertain(
      journal, files, "operation-manual", "transaction-manual"
    ).operation;
    journal.requireManualResolution({
      operationId: direct.operation_id,
      evidenceDigest: digest("4")
    });
    const unsigned = journal.issueReceipt({
      receiptId: "receipt-manual",
      operationId: direct.operation_id
    });
    assert.equal(unsigned.final_state, "manual_resolution");
    assert.equal(unsigned.verification_evidence_digest, digest("4"));
    assert.equal(unsigned.previous_receipt_hash, signed.receipt_hash);
    assert.equal(verifyEffectReceipt(unsigned), true);
    assert.throws(() => journal.issueReceipt({
      receiptId: "receipt-manual-again",
      operationId: direct.operation_id
    }), hasCode("EG_RECEIPT_ALREADY_EXISTS"));

    const database = new DatabaseSync(files.file);
    const stored = database.prepare(`SELECT receipt_json FROM effect_receipts
      WHERE receipt_id=?`).get(signed.receipt_id).receipt_json;
    database.close();
    for (const forbidden of [
      SECRET_BODY, PRIVATE_SCOPE, rawKey,
      "PROBE_RESULT_MUST_NOT_ENTER_RECEIPT"
    ]) {
      assert.equal(stored.includes(forbidden), false);
    }

    journal.close();
    journal = files.journal();
    assert.deepEqual(
      journal.loadReceipt(signed.receipt_id),
      signed
    );
    assert.deepEqual(
      journal.loadReceipt(unsigned.receipt_id),
      unsigned
    );
  } finally {
    try { journal.close(); } catch {}
    files.close();
  }
});

test("receipt rows are immutable and tampering is detected", () => {
  const files = fixture();
  let journal = files.journal();
  try {
    const uncertain = makeUncertain(
      journal, files, "operation-tamper", "transaction-tamper"
    ).operation;
    journal.requireManualResolution({
      operationId: uncertain.operation_id,
      evidenceDigest: digest("5")
    });
    journal.issueReceipt({
      receiptId: "receipt-tamper",
      operationId: uncertain.operation_id
    });
    journal.close();

    const database = new DatabaseSync(files.file);
    assert.throws(() => database.prepare(`UPDATE effect_receipts
      SET receipt_json='{}' WHERE receipt_id=?`).run("receipt-tamper"));
    database.exec("DROP TRIGGER effect_receipts_no_update");
    const row = database.prepare(`SELECT receipt_json FROM effect_receipts
      WHERE receipt_id=?`).get("receipt-tamper");
    const changed = JSON.parse(row.receipt_json);
    changed.safe_summary = "external_commit:verified_not_committed";
    database.prepare(`UPDATE effect_receipts SET receipt_json=?
      WHERE receipt_id=?`).run(JSON.stringify(changed), "receipt-tamper");
    database.close();

    journal = files.journal();
    assert.throws(
      () => journal.loadReceipt("receipt-tamper"),
      hasCode("EG_RECEIPT_CORRUPT")
    );
  } finally {
    try { journal.close(); } catch {}
    files.close();
  }
});
