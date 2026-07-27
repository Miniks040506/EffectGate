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

import { ApprovalLeaseStore } from "../src/policy/approval-lease-store.mjs";
import { compileEffectIntent } from "../src/policy/effect-intent.mjs";
import {
  EffectOperationJournal,
  OperationJournalError
} from "../src/policy/operation-journal.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

function intent(now, transactionId = "skill-transaction") {
  return compileEffectIntent({
    principalId: "principal-local",
    clientId: "effectgate-test",
    sessionId: "session-1",
    admission: {
      schema_version: "1.0.0",
      transaction_id: transactionId,
      skill_id: "document-editor",
      skill_digest: digest("a"),
      phase: "modify",
      phase_revision: 2,
      capsule_digest: digest("b"),
      capability_id: "filesystem.apply_patch",
      capability_revision: "patch-v1",
      effect_class: "mutate_reversible"
    },
    policyDecision: {
      decision: "ask",
      policy_revision: digest("c"),
      matched_rule_ids: ["ask-modify"],
      safe_reason_code: "policy_ask"
    },
    arguments: { secret: "MUST_NOT_ENTER_OPERATION_DB" },
    resourceScope: {
      kind: "exact",
      value: "repo:owner/name/path:docs/guide.md"
    },
    disclosureDigest: digest("d"),
    expiresAt: new Date(now + 10 * 60 * 1000).toISOString(),
    now: () => now
  });
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-operations-"));
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
    approvals: () => new ApprovalLeaseStore(config),
    close() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function assertCode(code, operation) {
  assert.throws(operation, (error) =>
    error instanceof OperationJournalError && error.code === code);
}

function allow(journal, operationId, operationIntent) {
  journal.plan({
    operationId,
    intent: operationIntent,
    approvalRequired: false
  });
  journal.preflight(operationId);
  return journal.admit(operationId);
}

test("operation journal durably orders admission before dispatch", () => {
  const files = fixture();
  let journal = files.journal();
  try {
    const operationIntent = intent(files.clock.wall);
    const planned = journal.plan({
      operationId: "operation-allow",
      intent: operationIntent,
      approvalRequired: false
    });
    assert.equal(planned.state, "planned");
    assert.equal(planned.intent_digest, operationIntent.intent_digest);
    assert.equal(planned.canonical_arguments_hash,
      operationIntent.canonical_arguments_hash);
    assert.equal(JSON.stringify(planned).includes(
      "MUST_NOT_ENTER_OPERATION_DB"), false);
    assertCode("EG_OPERATION_TRANSITION_DENIED", () =>
      journal.beginDispatch({
        operationId: "operation-allow",
        dispatchDigest: digest("e"),
        deadlineAt: new Date(files.clock.wall + 30_000).toISOString()
      }));

    journal.preflight("operation-allow");
    journal.admit("operation-allow");
    const executing = journal.beginDispatch({
      operationId: "operation-allow",
      dispatchDigest: digest("e"),
      deadlineAt: new Date(files.clock.wall + 30_000).toISOString()
    });
    assert.equal(executing.state, "executing");
    assert.equal(executing.certainty, "not_started");
    assert.equal(executing.dispatch_digest, digest("e"));
    assertCode("EG_OPERATION_TRANSITION_DENIED", () =>
      journal.preflight("operation-allow"));

    const loaded = journal.load("operation-allow");
    assert.deepEqual(
      loaded.events.map(({ new_state }) => new_state),
      ["planned", "preflighted", "admitted", "executing"]
    );
    assert.equal(loaded.events[3].previous_event_digest,
      loaded.events[2].event_digest);
    const stored = readdirSync(files.directory)
      .map((file) => readFileSync(join(files.directory, file)));
    assert.equal(stored.some((data) =>
      data.includes("MUST_NOT_ENTER_OPERATION_DB")), false);

    journal.close();
    journal = files.journal();
    assert.equal(journal.load("operation-allow").operation.state, "executing");
    journal.close();

    const tamper = new DatabaseSync(files.file);
    tamper.exec("DROP TRIGGER operation_events_no_update");
    tamper.prepare(`UPDATE operation_events SET certainty='commit_possible'
      WHERE operation_id=? AND sequence=4`).run("operation-allow");
    tamper.close();
    journal = files.journal();
    assertCode("EG_OPERATION_CORRUPT", () =>
      journal.load("operation-allow"));
  } finally {
    try { journal.close(); } catch {}
    files.close();
  }
});

test("startup recovery abandons undispatched work and preserves uncertainty", () => {
  const files = fixture();
  let journal = files.journal();
  let approvals = files.approvals();
  try {
    journal.plan({
      operationId: "operation-planned",
      intent: intent(files.clock.wall, "transaction-planned"),
      approvalRequired: false
    });
    journal.plan({
      operationId: "operation-preflighted",
      intent: intent(files.clock.wall, "transaction-preflighted"),
      approvalRequired: false
    });
    journal.preflight("operation-preflighted");

    const approvalIntent = intent(
      files.clock.wall, "transaction-awaiting"
    );
    journal.plan({
      operationId: "operation-awaiting",
      intent: approvalIntent,
      approvalRequired: true
    });
    journal.preflight("operation-awaiting");
    const challenge = approvals.createChallenge({ intent: approvalIntent });
    journal.awaitApproval({
      operationId: "operation-awaiting",
      challengeId: challenge.challenge_id
    });
    approvals.approveChallenge({
      challengeId: challenge.challenge_id,
      approverId: "operator-local",
      channel: "cli"
    });

    allow(
      journal,
      "operation-admitted",
      intent(files.clock.wall, "transaction-admitted")
    );
    allow(
      journal,
      "operation-executing",
      intent(files.clock.wall, "transaction-executing")
    );
    const deadlineAt = new Date(files.clock.wall + 30_000).toISOString();
    journal.beginDispatch({
      operationId: "operation-executing",
      dispatchDigest: digest("f"),
      deadlineAt
    });
    allow(
      journal,
      "operation-canceled",
      intent(files.clock.wall, "transaction-canceled")
    );
    journal.beginDispatch({
      operationId: "operation-canceled",
      dispatchDigest: digest("9"),
      deadlineAt
    });
    const canceled = journal.cancel("operation-canceled");
    assert.equal(canceled.state, "uncertain");
    assert.equal(canceled.certainty, "commit_possible");
    assert.equal(canceled.deadline_at, deadlineAt);
    approvals.close();
    journal.close();

    files.clock.wall += 1000;
    files.clock.monotonic += 1000;
    journal = files.journal();
    const recovered = journal.recover();
    assert.equal(recovered.length, 5);
    for (const operationId of [
      "operation-planned",
      "operation-preflighted",
      "operation-awaiting",
      "operation-admitted"
    ]) {
      const operation = journal.load(operationId).operation;
      assert.equal(operation.state, "abandoned");
      assert.equal(operation.certainty, "not_started");
    }
    const uncertain = journal.load("operation-executing").operation;
    assert.equal(uncertain.state, "uncertain");
    assert.equal(uncertain.certainty, "commit_possible");
    assert.equal(uncertain.dispatch_digest, digest("f"));
    assert.equal(uncertain.deadline_at, deadlineAt);
    assert.deepEqual(journal.recover(), []);

    const database = new DatabaseSync(files.file);
    const challengeRow = database.prepare(`SELECT status FROM
      approval_challenges WHERE challenge_id=?`).get(challenge.challenge_id);
    const leaseRow = database.prepare(`SELECT expired_at FROM approval_leases
      WHERE challenge_id=?`).get(challenge.challenge_id);
    database.close();
    assert.equal(challengeRow.status, "expired");
    assert.ok(leaseRow.expired_at);
  } finally {
    try { approvals.close(); } catch {}
    try { journal.close(); } catch {}
    files.close();
  }
});
