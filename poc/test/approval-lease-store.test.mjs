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
    close() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function assertCode(code, operation) {
  assert.throws(operation, (error) =>
    error instanceof ApprovalLeaseError && error.code === code);
}

test("approval lease survives restart, consumes once, and stores no bearer", () => {
  const files = fixture();
  let store = files.store();
  try {
    const approvedIntent = intent(files.clock.wall);
    const challenge = store.createChallenge({ intent: approvedIntent });
    assert.deepEqual(challenge.summary, {
      capability_id: "filesystem.apply_patch",
      effect_class: "mutate_reversible",
      resource_scope: {
        kind: "exact",
        value: "repo:owner/name/path:docs/guide.md"
      }
    });
    const lease = store.approveChallenge({
      challengeId: challenge.challenge_id,
      approverId: "operator-local",
      channel: "cli"
    });
    assert.match(lease.lease_token, /^egl_[A-Za-z0-9_-]{43}$/u);
    const stored = readdirSync(files.directory)
      .map((file) => readFileSync(join(files.directory, file)));
    assert.equal(stored.some((data) => data.includes(lease.lease_token)), false);
    assert.equal(stored.some((data) =>
      data.includes("MUST_NOT_ENTER_APPROVAL_DB")), false);

    store.close();
    store = files.store();
    const proof = store.consumeLease({
      leaseToken: lease.lease_token,
      intentDigest: approvedIntent.intent_digest,
      sessionId: approvedIntent.session_id,
      operationId: "operation-1"
    });
    assert.equal(proof.intent_digest, approvedIntent.intent_digest);
    assert.match(proof.approval_proof_digest, /^sha256:[a-f0-9]{64}$/u);
    assertCode("EG_APPROVAL_NOT_ADMISSIBLE", () => store.consumeLease({
      leaseToken: lease.lease_token,
      intentDigest: approvedIntent.intent_digest,
      sessionId: approvedIntent.session_id,
      operationId: "operation-2"
    }));
    const secondLease = store.approveChallenge({
      challengeId: store.createChallenge({
        intent: approvedIntent
      }).challenge_id,
      approverId: "operator-local",
      channel: "cli"
    });
    assertCode("EG_APPROVAL_NOT_ADMISSIBLE", () => store.consumeLease({
      leaseToken: secondLease.lease_token,
      intentDigest: approvedIntent.intent_digest,
      sessionId: approvedIntent.session_id,
      operationId: "operation-1"
    }));
  } finally {
    try { store.close(); } catch {}
    files.close();
  }
});

test("approval leases expire, revoke, isolate sessions, and detect rollback", () => {
  const files = fixture();
  const store = files.store();
  try {
    const firstIntent = intent(files.clock.wall);
    const first = store.approveChallenge({
      challengeId: store.createChallenge({
        intent: firstIntent,
        ttlMs: 1000
      }).challenge_id,
      approverId: "operator-local",
      channel: "local_tui"
    });
    assertCode("EG_APPROVAL_NOT_ADMISSIBLE", () => store.consumeLease({
      leaseToken: first.lease_token,
      intentDigest: firstIntent.intent_digest,
      sessionId: "session-other",
      operationId: "operation-wrong-session"
    }));
    files.clock.wall += 1000;
    files.clock.monotonic += 1000;
    assertCode("EG_APPROVAL_EXPIRED", () => store.consumeLease({
      leaseToken: first.lease_token,
      intentDigest: firstIntent.intent_digest,
      sessionId: firstIntent.session_id,
      operationId: "operation-expired"
    }));

    const secondIntent = intent(files.clock.wall, "session-2");
    const second = store.approveChallenge({
      challengeId: store.createChallenge({ intent: secondIntent }).challenge_id,
      approverId: "operator-local",
      channel: "mcp_elicitation"
    });
    assert.equal(store.revoke({ sessionId: "session-2" }).revoked, 1);
    assertCode("EG_APPROVAL_NOT_ADMISSIBLE", () => store.consumeLease({
      leaseToken: second.lease_token,
      intentDigest: secondIntent.intent_digest,
      sessionId: secondIntent.session_id,
      operationId: "operation-revoked"
    }));

    const thirdIntent = intent(files.clock.wall, "session-3");
    const third = store.approveChallenge({
      challengeId: store.createChallenge({ intent: thirdIntent }).challenge_id,
      approverId: "operator-local",
      channel: "cli"
    });
    files.clock.wall -= 1;
    assertCode("EG_APPROVAL_CLOCK_ROLLBACK", () => store.consumeLease({
      leaseToken: third.lease_token,
      intentDigest: thirdIntent.intent_digest,
      sessionId: thirdIntent.session_id,
      operationId: "operation-rollback"
    }));
  } finally {
    store.close();
    files.close();
  }
});
