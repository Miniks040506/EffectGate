import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  ApprovalLeaseError,
  ApprovalLeaseStore
} from "../src/policy/approval-lease-store.mjs";
import { compileEffectIntent } from "../src/policy/effect-intent.mjs";
import { EffectOperationJournal } from "../src/policy/operation-journal.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

function intent(now, sessionId = "session-1") {
  return compileEffectIntent({
    principalId: "principal-local",
    clientId: "effectgate-test",
    sessionId,
    admission: {
      schema_version: "1.0.0",
      transaction_id: "skill-transaction",
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
    arguments: { secret: "MUST_NOT_ENTER_APPROVAL_DB" },
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
  const directory = mkdtempSync(join(tmpdir(), "effectgate-approval-"));
  const clock = {
    wall: Date.parse("2026-07-28T00:00:00.000Z"),
    monotonic: 1000
  };
  return {
    directory,
    file: join(directory, "approval.db"),
    clock,
    store() {
      return new ApprovalLeaseStore({
        file: this.file,
        now: () => clock.wall,
        monotonic: () => clock.monotonic
      });
    },
    journal() {
      return new EffectOperationJournal({
        file: this.file,
        now: () => clock.wall,
        monotonic: () => clock.monotonic
      });
    },
    close() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function assertCode(code, operation) {
  assert.throws(operation, (error) =>
    error instanceof ApprovalLeaseError && error.code === code);
}

function leaseFor(store, journal, approvedIntent, operationId, options = {}) {
  journal.plan({
    operationId,
    intent: approvedIntent,
    approvalRequired: true
  });
  journal.preflight(operationId);
  const challenge = store.createChallenge({
    intent: approvedIntent,
    ...options.challenge
  });
  journal.awaitApproval({
    operationId,
    challengeId: challenge.challenge_id
  });
  const lease = store.approveChallenge({
    challengeId: challenge.challenge_id,
    approverId: "operator-local",
    channel: options.channel ?? "cli"
  });
  return { challenge, lease };
}

test("approval lease survives restart and atomically admits once", () => {
  const files = fixture();
  let store = files.store();
  let journal = files.journal();
  try {
    const approvedIntent = intent(files.clock.wall);
    const { challenge, lease } = leaseFor(
      store,
      journal,
      approvedIntent,
      "operation-1"
    );
    assert.deepEqual(challenge.summary, {
      capability_id: "filesystem.apply_patch",
      effect_class: "mutate_reversible",
      resource_scope: {
        kind: "exact",
        value: "repo:owner/name/path:docs/guide.md"
      }
    });
    assert.match(lease.lease_token, /^egl_[A-Za-z0-9_-]{43}$/u);
    const stored = readdirSync(files.directory)
      .map((file) => readFileSync(join(files.directory, file)));
    assert.equal(stored.some((data) => data.includes(lease.lease_token)), false);
    assert.equal(stored.some((data) =>
      data.includes("MUST_NOT_ENTER_APPROVAL_DB")), false);

    store.close();
    journal.close();
    store = files.store();
    journal = files.journal();
    const proof = store.admitOperation({
      leaseToken: lease.lease_token,
      intent: approvedIntent,
      operationId: "operation-1"
    });
    assert.equal(proof.intent_digest, approvedIntent.intent_digest);
    assert.match(proof.approval_proof_digest, /^sha256:[a-f0-9]{64}$/u);
    assert.equal(journal.load("operation-1").operation.state, "admitted");
    assert.equal(
      journal.load("operation-1").operation.approval_proof_digest,
      proof.approval_proof_digest
    );
    assertCode("EG_APPROVAL_NOT_ADMISSIBLE", () => store.admitOperation({
      leaseToken: lease.lease_token,
      intent: approvedIntent,
      operationId: "operation-1"
    }));

    const otherIntent = intent(files.clock.wall, "session-2");
    const second = leaseFor(
      store,
      journal,
      otherIntent,
      "operation-2"
    );
    assertCode("EG_APPROVAL_NOT_ADMISSIBLE", () => store.admitOperation({
      leaseToken: second.lease.lease_token,
      intent: approvedIntent,
      operationId: "operation-2"
    }));
    const secondProof = store.admitOperation({
      leaseToken: second.lease.lease_token,
      intent: otherIntent,
      operationId: "operation-2"
    });
    assert.equal(secondProof.operation_id, "operation-2");
  } finally {
    try { store.close(); } catch {}
    try { journal.close(); } catch {}
    files.close();
  }
});

test("approval leases expire, revoke, isolate sessions, and detect rollback", () => {
  const files = fixture();
  const store = files.store();
  const journal = files.journal();
  try {
    const firstIntent = intent(files.clock.wall);
    const first = leaseFor(
      store,
      journal,
      firstIntent,
      "operation-expired",
      { challenge: { ttlMs: 1000 }, channel: "local_tui" }
    ).lease;
    assertCode("EG_APPROVAL_NOT_ADMISSIBLE", () => store.admitOperation({
      leaseToken: first.lease_token,
      intent: intent(files.clock.wall, "session-other"),
      operationId: "operation-expired"
    }));
    files.clock.wall += 1000;
    files.clock.monotonic += 1000;
    assertCode("EG_APPROVAL_EXPIRED", () => store.admitOperation({
      leaseToken: first.lease_token,
      intent: firstIntent,
      operationId: "operation-expired"
    }));

    const secondIntent = intent(files.clock.wall, "session-2");
    const second = leaseFor(
      store,
      journal,
      secondIntent,
      "operation-revoked",
      { channel: "mcp_elicitation" }
    ).lease;
    assert.equal(store.revoke({ sessionId: "session-2" }).revoked, 1);
    assertCode("EG_APPROVAL_NOT_ADMISSIBLE", () => store.admitOperation({
      leaseToken: second.lease_token,
      intent: secondIntent,
      operationId: "operation-revoked"
    }));

    const thirdIntent = intent(files.clock.wall, "session-3");
    const third = leaseFor(
      store,
      journal,
      thirdIntent,
      "operation-rollback"
    ).lease;
    files.clock.wall -= 1;
    assertCode("EG_APPROVAL_CLOCK_ROLLBACK", () => store.admitOperation({
      leaseToken: third.lease_token,
      intent: thirdIntent,
      operationId: "operation-rollback"
    }));
  } finally {
    store.close();
    journal.close();
    files.close();
  }
});
