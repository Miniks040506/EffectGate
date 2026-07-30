import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { compileEffectIntent } from "../src/policy/effect-intent.mjs";
import {
  EffectOperationJournal,
  OperationJournalError
} from "../src/policy/operation-journal.mjs";
import {
  compileVerificationProbe
} from "../src/policy/verification-probe.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

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
    arguments: { body: "MUST_NOT_ENTER_RECONCILIATION_DB" },
    resourceScope: { kind: "exact", value: "comment://123" },
    disclosureDigest: digest("d"),
    expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
    now: () => now
  });
}

function probe(overrides = {}) {
  return compileVerificationProbe({
    schema_version: "1.0.0",
    capability_id: "comments.create",
    capability_revision: "comments-v1",
    kind: "lookup_by_fingerprint",
    probe: {
      capability_id: overrides.probeCapability ?? "comments.lookup",
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
      max_attempts: overrides.maxAttempts ?? 2,
      per_attempt_timeout_ms: 50,
      total_timeout_ms: overrides.totalTimeoutMs ?? 1000,
      max_result_bytes: 4096,
      initial_backoff_ms: 10,
      max_backoff_ms: 10,
      observation_window_ms: overrides.observationWindowMs ?? 0
    },
    evidence: {
      trust_level: "qualified_probe",
      redaction: "digest_only"
    },
    qualification_evidence_digest: digest("e")
  });
}

function result(data, character = "f") {
  return {
    data,
    evidence_ref: `evidence://reconciliation/${character}`,
    evidence_digest: digest(character)
  };
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-reconcile-"));
  const clock = {
    wall: Date.parse("2026-07-28T00:00:00.000Z"),
    monotonic: 1000
  };
  const config = {
    file: join(directory, "effectgate.db"),
    now: () => clock.wall,
    monotonic: () => clock.monotonic
  };
  return {
    directory,
    file: config.file,
    clock,
    journal: () => new EffectOperationJournal(config),
    close() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function dispatchUncertain(
  journal, files, operationId, transactionId, checkBoundary = false
) {
  journal.plan({
    operationId,
    intent: intent(files.clock.wall, transactionId),
    approvalRequired: false
  });
  journal.preflight(operationId);
  journal.admit(operationId);
  journal.beginDispatch({
    operationId,
    dispatchDigest: digest("1"),
    deadlineAt: new Date(files.clock.wall + 30_000).toISOString()
  });
  if (checkBoundary) {
    assert.throws(
      () => journal.markUncertain({ operationId }),
      hasCode("EG_OPERATION_UNCERTAINTY_INVALID")
    );
  }
  return journal.markUncertain({
    operationId,
    certainty: "commit_possible",
    evidenceRef: digest("2"),
    reason: "response_lost_after_dispatch"
  });
}

const hasCode = (code) => (error) =>
  error instanceof OperationJournalError && error.code === code;

test("reconciliation persistence is immutable and content-free", () => {
  const files = fixture();
  const journal = files.journal();
  try {
    journal.close();
    const database = new DatabaseSync(files.file);
    const tables = database.prepare(`SELECT name FROM sqlite_master
      WHERE type='table' AND name LIKE 'operation_reconciliation%'
      OR type='table' AND name='operation_verification_attempts'
      ORDER BY name`).all().map(({ name }) => name);
    assert.deepEqual(tables, [
      "operation_reconciliation_outcomes",
      "operation_reconciliations",
      "operation_verification_attempts"
    ]);
    const triggers = database.prepare(`SELECT name FROM sqlite_master
      WHERE type='trigger' AND (name LIKE 'operation_reconciliation%'
      OR name LIKE 'operation_verification_attempts%')
      ORDER BY name`).all().map(({ name }) => name);
    assert.equal(triggers.length, 6);
    const sql = database.prepare(`SELECT group_concat(sql, ' ')
      AS sql FROM sqlite_master WHERE name IN
      ('operation_reconciliations','operation_verification_attempts',
       'operation_reconciliation_outcomes')`).get().sql;
    assert.doesNotMatch(sql, /result_json|raw_result|arguments_json|secret/iu);
    database.close();
  } finally {
    try { journal.close(); } catch {}
    files.close();
  }
});

test("committed evidence finalizes durably without exposing probe data", async () => {
  const files = fixture();
  let journal = files.journal();
  try {
    const uncertain = dispatchUncertain(
      journal, files, "operation-committed", "transaction-committed", true
    );
    assert.throws(() => journal.plan({
      operationId: "operation-blind-retry",
      intent: intent(files.clock.wall, "transaction-committed"),
      approvalRequired: false
    }), hasCode("EG_OPERATION_INTENT_REUSE"));
    const descriptor = probe();
    const completed = await journal.reconcile({
      operationId: uncertain.operation_id,
      descriptor,
      invoke: async () => result({
        status: "found",
        intent_digest: uncertain.intent_digest,
        secret: "PROBE_SECRET_MUST_NOT_ESCAPE"
      }),
      probeNow: () => 0
    });
    assert.equal(completed.state, "verified_committed");
    assert.equal(completed.certainty, "verified_committed");
    assert.equal(completed.reconciliation.attempts.length, 1);
    assert.equal(
      completed.reconciliation.outcome.outcome,
      "verified_committed"
    );
    assert.equal(
      JSON.stringify(completed).includes("PROBE_SECRET_MUST_NOT_ESCAPE"),
      false
    );
    assert.deepEqual(
      journal.load(uncertain.operation_id).events.map(
        ({ new_state: state }) => state
      ),
      [
        "planned", "preflighted", "admitted", "executing", "uncertain",
        "reconciling", "verified_committed"
      ]
    );
    assert.throws(() => journal.beginDispatch({
      operationId: uncertain.operation_id,
      dispatchDigest: digest("3"),
      deadlineAt: new Date(files.clock.wall + 30_000).toISOString()
    }), hasCode("EG_OPERATION_TRANSITION_DENIED"));

    journal.close();
    journal = files.journal();
    assert.equal(
      journal.load(uncertain.operation_id).operation.state,
      "verified_committed"
    );
  } finally {
    try { journal.close(); } catch {}
    files.close();
  }
});

test("verified-not-committed permits only a fresh admitted operation", async () => {
  const files = fixture();
  const journal = files.journal();
  try {
    const uncertain = dispatchUncertain(
      journal, files, "operation-absent", "transaction-absent"
    );
    const completed = await journal.reconcile({
      operationId: uncertain.operation_id,
      descriptor: probe({ maxAttempts: 1 }),
      invoke: async () => result({ status: "not_found" }),
      probeNow: () => 0
    });
    assert.equal(completed.state, "verified_not_committed");
    assert.equal(completed.certainty, "verified_not_committed");
    assert.throws(() => journal.plan({
      operationId: "operation-reused-intent",
      intent: intent(files.clock.wall, "transaction-absent"),
      approvalRequired: false
    }), hasCode("EG_OPERATION_INTENT_REUSE"));
    await assert.rejects(
      journal.reconcile({
        operationId: uncertain.operation_id,
        descriptor: probe({ maxAttempts: 1 }),
        invoke: async () => result({ status: "not_found" })
      }),
      hasCode("EG_OPERATION_RETRY_DENIED")
    );

    journal.plan({
      operationId: "operation-fresh",
      intent: intent(files.clock.wall, "transaction-fresh"),
      approvalRequired: false
    });
    journal.preflight("operation-fresh");
    assert.equal(journal.admit("operation-fresh").state, "admitted");
  } finally {
    journal.close();
    files.close();
  }
});

test("irreducible ambiguity becomes manual resolution", async () => {
  const files = fixture();
  const journal = files.journal();
  try {
    const uncertain = dispatchUncertain(
      journal, files, "operation-manual", "transaction-manual"
    );
    const completed = await journal.reconcile({
      operationId: uncertain.operation_id,
      descriptor: probe({ maxAttempts: 1 }),
      invoke: async () => result({ status: "ambiguous" }),
      probeNow: () => 0
    });
    assert.equal(completed.state, "manual_resolution");
    assert.equal(completed.certainty, "commit_possible");
    assert.equal(completed.recovery_reason, "verification_ambiguous");
    assert.equal(
      completed.reconciliation.outcome.outcome,
      "manual_resolution"
    );

    const deferred = dispatchUncertain(
      journal, files, "operation-deferred", "transaction-deferred"
    );
    const reconciling = await journal.reconcile({
      operationId: deferred.operation_id,
      descriptor: probe({ maxAttempts: 2 }),
      invoke: async () => result({ status: "ambiguous" }),
      attemptLimit: 1,
      probeNow: () => 0
    });
    assert.equal(reconciling.state, "reconciling");
    assert.equal(journal.requireManualResolution({
      operationId: deferred.operation_id,
      evidenceDigest: digest("7")
    }).state, "manual_resolution");

    const unavailable = dispatchUncertain(
      journal, files, "operation-unverifiable", "transaction-unverifiable"
    );
    const withoutProbe = journal.requireManualResolution({
      operationId: unavailable.operation_id,
      evidenceDigest: digest("8")
    });
    assert.equal(withoutProbe.state, "manual_resolution");
    assert.equal(withoutProbe.reconciliation, null);
    assert.equal(withoutProbe.recovery_reason, "verification_unavailable");
  } finally {
    journal.close();
    files.close();
  }
});

test("restart resumes the remaining budget and detects attempt tampering", async () => {
  const files = fixture();
  let journal = files.journal();
  try {
    const uncertain = dispatchUncertain(
      journal, files, "operation-resume", "transaction-resume"
    );
    const descriptor = probe({ maxAttempts: 2 });
    let enteredSleep;
    const sleeping = new Promise((resolve) => {
      enteredSleep = resolve;
    });
    void journal.reconcile({
      operationId: uncertain.operation_id,
      descriptor,
      invoke: async () => result({ status: "ambiguous" }),
      probeNow: () => 0,
      sleep: async () => {
        enteredSleep();
        return new Promise(() => {});
      }
    });
    await sleeping;
    const interrupted = journal.load(uncertain.operation_id).operation;
    assert.equal(interrupted.state, "reconciling");
    assert.deepEqual(
      interrupted.reconciliation.attempts.map(({ attempt }) => attempt),
      [1]
    );
    journal.close();

    files.clock.wall += 100;
    files.clock.monotonic += 100;
    journal = files.journal();
    await assert.rejects(
      journal.reconcile({
        operationId: uncertain.operation_id,
        descriptor: probe({
          maxAttempts: 2,
          probeCapability: "comments.lookup.changed"
        }),
        invoke: async () => result({ status: "found" })
      }),
      hasCode("EG_RECONCILIATION_DESCRIPTOR_MISMATCH")
    );
    const completed = await journal.reconcile({
      operationId: uncertain.operation_id,
      descriptor,
      invoke: async () => result({
        status: "found",
        intent_digest: uncertain.intent_digest
      }),
      probeNow: () => 0
    });
    assert.equal(completed.state, "verified_committed");
    assert.deepEqual(
      completed.reconciliation.attempts.map(({ attempt }) => attempt),
      [1, 2]
    );
    journal.close();

    const database = new DatabaseSync(files.file);
    database.exec("DROP TRIGGER operation_verification_attempts_no_update");
    database.prepare(`UPDATE operation_verification_attempts
      SET classification='committed' WHERE operation_id=? AND attempt=1`
    ).run(uncertain.operation_id);
    database.close();
    journal = files.journal();
    assert.throws(
      () => journal.load(uncertain.operation_id),
      hasCode("EG_OPERATION_CORRUPT")
    );
  } finally {
    try { journal.close(); } catch {}
    files.close();
  }
});
