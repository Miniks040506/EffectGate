import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  compileInstructionCapsule,
  instructionCapsuleDigest
} from "../src/skill/capsule-compiler.mjs";
import { compileSkillPassport } from "../src/skill/passport-compiler.mjs";
import {
  admitPhaseEffectOperation,
  dispatchPhaseEffectOperation,
  EffectAdmissionError,
  planPhaseEffectOperation,
  preparePhaseEffect
} from "../src/policy/phase-effect-admission.mjs";
import {
  ApprovalLeaseError,
  ApprovalLeaseStore
} from "../src/policy/approval-lease-store.mjs";
import {
  EffectOperationJournal
} from "../src/policy/operation-journal.mjs";
import {
  compileIdempotencyAdapter
} from "../src/policy/idempotency-adapter.mjs";
import { compilePolicy } from "../src/policy/policy-compiler.mjs";
import {
  compileVerificationProbe
} from "../src/policy/verification-probe.mjs";
import { SkillTransaction } from "../src/skill/phase-transaction.mjs";
import { SkillEventStore } from "../src/skill/skill-event-store.mjs";
import { SkillSourceError, importSkillSource } from "../src/skill/source-import.mjs";

const ARTIFACT_DIGEST = `sha256:${"a".repeat(64)}`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "effectgate-phase-"));
  const files = {
    "SKILL.md": "Keep the original until verification.\n",
    "phases/inspect.md": "Inspect.\n",
    "phases/modify.md": "Modify.\n"
  };
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const source = importSkillSource({ root, paths: Object.keys(files) });
  const phases = {
    inspect: {
      instruction_refs: ["phases/inspect.md"],
      allowed_tools: ["filesystem.read"],
      allowed_effect_classes: ["observe"],
      transition: { on_success: "modify" }
    },
    modify: {
      instruction_refs: ["phases/modify.md"],
      allowed_tools: ["filesystem.apply_patch"],
      allowed_effect_classes: ["mutate_reversible"]
    }
  };
  const passport = compileSkillPassport({
    source,
    skill: {
      id: "document-editor",
      version: "1.4.0",
      trust_tier: "local_reviewed"
    },
    invariants: [{
      id: "preserve-original",
      source_ref: "SKILL.md#safety",
      pin: "transaction",
      class: "safety"
    }],
    phases,
    declaredTools: ["filesystem.read", "filesystem.apply_patch"],
    declaredEffectClasses: ["observe", "mutate_reversible"]
  });
  const capabilities = {
    "filesystem.read": { revision: "read-v1", effect_class: "observe" },
    "filesystem.apply_patch": {
      revision: "patch-v1",
      effect_class: "mutate_reversible"
    }
  };
  const capsule = (phase, phaseRevision) => compileInstructionCapsule({
    passport,
    source,
    phase,
    capabilities,
    phaseRevision,
    maxTokens: 5000,
    maxBytes: 20000,
    expiresAt: "2026-07-29T00:00:00.000Z"
  });
  return {
    passport,
    capsule,
    databaseFile: join(root, "events.db"),
    close() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function assertCode(code, operation) {
  assert.throws(operation, (error) =>
    error instanceof SkillSourceError && error.code === code);
}

test("phase transaction evicts Capsules and replaces them with receipts", () => {
  const files = fixture();
  try {
    const transaction = new SkillTransaction({
      transactionId: "transaction-1",
      passport: files.passport,
      initialPhase: "inspect",
      now: () => Date.parse("2026-07-28T00:00:00.000Z")
    });
    const inspect = files.capsule("inspect", 1);
    const forge = (change) => {
      const { capsule_digest: ignored, ...body } = structuredClone(inspect);
      change(body);
      return { ...body, capsule_digest: instructionCapsuleDigest(body) };
    };
    assertCode("EG_PHASE_TOOL_NOT_ALLOWED", () =>
      transaction.activateCapsule(forge((body) => body.allowed_tools.push({
        capability_id: "filesystem.apply_patch",
        capability_revision: "patch-v1",
        effect_class: "mutate_reversible"
      }))));
    assertCode("EG_PHASE_EFFECT_CLASS_NOT_ALLOWED", () =>
      transaction.activateCapsule(forge((body) => {
        body.allowed_tools[0].effect_class = "mutate_reversible";
      })));
    transaction.activateCapsule(inspect);
    const first = transaction.reportPhaseOutcome({
      capsuleDigest: inspect.capsule_digest,
      status: "completed",
      inputArtifactDigests: [ARTIFACT_DIGEST],
      findingRefs: ["artifact://findings/inspect"]
    });
    assert.equal(first.next_phase, "modify");
    assert.equal(transaction.snapshot().status, "awaiting_capsule");
    assert.equal(transaction.snapshot().active_capsule_digest, null);
    assertCode("EG_PHASE_TRANSITION_DENIED", () =>
      transaction.reportPhaseOutcome({
        capsuleDigest: inspect.capsule_digest,
        status: "completed"
      }));

    const modify = files.capsule("modify", 2);
    transaction.activateCapsule(modify);
    const final = transaction.reportPhaseOutcome({
      capsuleDigest: modify.capsule_digest,
      status: "completed",
      effectReceiptRefs: ["receipt://effect/1"]
    });
    assert.equal(final.next_phase, null);
    assert.equal(transaction.snapshot().status, "completed");
    assert.equal(transaction.receipts().length, 2);
    assert.ok(Object.isFrozen(first));
  } finally {
    files.close();
  }
});

test("phase transaction persists and recovers its admissible state", () => {
  const files = fixture();
  let store = new SkillEventStore({ file: files.databaseFile });
  try {
    const transaction = new SkillTransaction({
      transactionId: "transaction-persisted",
      passport: files.passport,
      initialPhase: "inspect",
      now: () => Date.parse("2026-07-28T00:00:00.000Z"),
      eventStore: store
    });
    const inspect = files.capsule("inspect", 1);
    transaction.activateCapsule(inspect);
    transaction.reportPhaseOutcome({
      capsuleDigest: inspect.capsule_digest,
      status: "completed",
      inputArtifactDigests: [ARTIFACT_DIGEST]
    });
    store.close();

    store = new SkillEventStore({ file: files.databaseFile });
    const recovered = SkillTransaction.recover({
      transactionId: "transaction-persisted",
      passport: files.passport,
      eventStore: store,
      now: () => Date.parse("2026-07-28T12:00:00.000Z")
    });
    assert.deepEqual(recovered.snapshot(), {
      transaction_id: "transaction-persisted",
      status: "awaiting_capsule",
      current_phase: "modify",
      next_phase_revision: 2,
      active_capsule_digest: null,
      receipt_count: 1
    });

    const modify = files.capsule("modify", 2);
    recovered.activateCapsule(modify);
    assert.equal(SkillTransaction.recover({
      transactionId: "transaction-persisted",
      passport: files.passport,
      eventStore: store,
      now: () => Date.parse("2026-07-28T12:00:00.000Z")
    }).snapshot().status, "active");
    const expired = SkillTransaction.recover({
      transactionId: "transaction-persisted",
      passport: files.passport,
      eventStore: store,
      now: () => Date.parse("2026-07-30T00:00:00.000Z")
    }).snapshot();
    assert.equal(expired.status, "awaiting_capsule");
    assert.equal(expired.current_phase, "modify");
    assert.equal(expired.next_phase_revision, 2);
    assert.equal(expired.active_capsule_digest, null);
  } finally {
    store.close();
    files.close();
  }
});

test("protected intent preparation binds the active phase and Capsule", async () => {
  const files = fixture();
  const now = Date.parse("2026-07-28T00:00:00.000Z");
  try {
    const transaction = new SkillTransaction({
      transactionId: "transaction-protected",
      passport: files.passport,
      initialPhase: "modify",
      now: () => now
    });
    const capsule = files.capsule("modify", 1);
    transaction.activateCapsule(capsule);
    const match = {
      skill_id: files.passport.skill.id,
      skill_digest: files.passport.skill.source_digest,
      phase: "modify",
      phase_revision: 1,
      capsule_digest: capsule.capsule_digest,
      capability_id: "filesystem.apply_patch",
      capability_revision: "patch-v1",
      effect_class: "mutate_reversible"
    };
    const policy = compilePolicy({
      policyId: "skill-protected",
      rules: [{ id: "ask-modify", match, decision: "ask" }]
    });
    const effect = (overrides = {}) => ({
      transaction,
      capsule,
      capsuleDigest: capsule.capsule_digest,
      capabilityId: "filesystem.apply_patch",
      capabilityRevision: "patch-v1",
      effectClass: "mutate_reversible",
      policy,
      principalId: "principal-local",
      clientId: "effectgate-test",
      sessionId: "session-protected",
      arguments: { patch: "MUST_NOT_APPEAR_IN_PREPARATION" },
      resourceScope: {
        kind: "exact",
        value: "repo:effectgate/path:docs/guide.md"
      },
      disclosureDigest: ARTIFACT_DIGEST,
      expiresAt: "2026-07-28T00:05:00.000Z",
      now: () => now,
      ...overrides
    });
    const prepare = (overrides = {}) =>
      preparePhaseEffect(effect(overrides));
    const prepared = prepare();
    assert.equal(prepared.status, "approval_required");
    assert.equal(prepared.approval_required, true);
    assert.equal(prepared.intent.skill_digest, match.skill_digest);
    assert.equal(prepared.intent.phase, match.phase);
    assert.equal(prepared.intent.phase_revision, match.phase_revision);
    assert.equal(prepared.intent.capsule_digest, match.capsule_digest);
    assert.equal(
      prepared.intent.capability_revision,
      match.capability_revision
    );
    assert.equal(
      JSON.stringify(prepared).includes("MUST_NOT_APPEAR_IN_PREPARATION"),
      false
    );
    assert.ok(Object.isFrozen(prepared.intent.resource_scope));
    const operationFile = join(
      dirname(files.databaseFile),
      "protected-operation.db"
    );
    const approval = new ApprovalLeaseStore({
      file: operationFile,
      now: () => now,
      monotonic: () => 1000
    });
    const journal = new EffectOperationJournal({
      file: operationFile,
      now: () => now,
      monotonic: () => 1000
    });
    try {
      const pending = planPhaseEffectOperation({
        operationId: "operation-protected",
        journal,
        approvals: approval,
        effect: effect()
      });
      assert.equal(pending.status, "awaiting_approval");
      assert.equal(pending.approval_required, true);
      const lease = approval.approveChallenge({
        challengeId: pending.challenge.challenge_id,
        approverId: "operator-local",
        channel: "cli"
      });
      assert.throws(() => admitPhaseEffectOperation({
        operationId: "operation-protected",
        approvals: approval,
        leaseToken: lease.lease_token,
        intent: pending.intent,
        effect: effect({
          arguments: { patch: "materially changed patch" }
        })
      }), (error) =>
        error instanceof EffectAdmissionError &&
        error.safeReasonCode === "intent_changed");
      assert.equal(
        journal.load("operation-protected").operation.state,
        "awaiting_approval"
      );
      const admitted = admitPhaseEffectOperation({
        operationId: "operation-protected",
        approvals: approval,
        leaseToken: lease.lease_token,
        intent: pending.intent,
        effect: effect()
      });
      assert.equal(admitted.status, "admitted");
      assert.equal(
        admitted.approval_proof.intent_digest,
        pending.intent.intent_digest
      );
      assert.deepEqual(
        journal.load("operation-protected").events.map(
          ({ new_state: state }) => state
        ),
        ["planned", "preflighted", "awaiting_approval", "admitted"]
      );
      assert.throws(() => admitPhaseEffectOperation({
        operationId: "operation-protected",
        approvals: approval,
        leaseToken: lease.lease_token,
        intent: pending.intent,
        effect: effect()
      }), ApprovalLeaseError);

      assert.throws(() => planPhaseEffectOperation({
        operationId: "operation-no-approval-store",
        journal,
        effect: effect()
      }), (error) =>
        error instanceof EffectAdmissionError &&
        error.safeReasonCode === "approval_unavailable");
      assert.equal(journal.load("operation-no-approval-store"), undefined);
      assert.throws(() => planPhaseEffectOperation({
        operationId: "operation-invalid-challenge",
        journal,
        approvals: approval,
        effect: effect(),
        challengeTtlMs: 0
      }), TypeError);
      assert.equal(journal.load("operation-invalid-challenge"), undefined);
    } finally {
      journal.close();
      approval.close();
    }

    const allowPolicy = compilePolicy({
      policyId: "skill-protected",
      rules: [{ id: "allow-modify", match, decision: "allow" }]
    });
    const allowed = prepare({ policy: allowPolicy });
    assert.equal(allowed.status, "policy_allowed");
    assert.equal(allowed.approval_required, false);
    const allowFile = join(
      dirname(files.databaseFile),
      "allowed-operation.db"
    );
    const allowJournal = new EffectOperationJournal({
      file: allowFile,
      now: () => now,
      monotonic: () => 1000
    });
    try {
      const allowedOperation = planPhaseEffectOperation({
        operationId: "operation-allowed",
        journal: allowJournal,
        effect: effect({
          policy: allowPolicy,
          arguments: { patch: "different admitted patch" }
        })
      });
      assert.equal(allowedOperation.status, "admitted");
      assert.equal(allowedOperation.challenge, null);
      assert.deepEqual(
        allowJournal.load("operation-allowed").events.map(
          ({ new_state: state }) => state
        ),
        ["planned", "preflighted", "admitted"]
      );
      const adapter = compileIdempotencyAdapter({
        schema_version: "1.0.0",
        capability_id: "filesystem.apply_patch",
        capability_revision: "patch-v1",
        key_placement: {
          target: "headers",
          name: "Idempotency-Key"
        },
        lookup: {
          capability_id: "filesystem.patch.lookup",
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
        qualification_evidence_digest: ARTIFACT_DIGEST
      });
      const backend = new Map();
      let writeCount = 0;
      let duplicateWriteCount = 0;
      const lost = await dispatchPhaseEffectOperation({
        operationId: "operation-allowed",
        journal: allowJournal,
        effect: effect({
          policy: allowPolicy,
          arguments: { patch: "different admitted patch" }
        }),
        adapter,
        request: {
          arguments: { patch: "different admitted patch" },
          headers: {}
        },
        deadlineAt: "2026-07-28T00:01:00.000Z",
        invoke: async (request) => {
          const key = request.headers["Idempotency-Key"];
          if (backend.has(key)) {
            duplicateWriteCount += 1;
          } else {
            writeCount += 1;
            backend.set(key, {
              intent_digest: allowedOperation.intent.intent_digest,
              backend_reference: "patch://docs/guide/1"
            });
          }
          throw new Error("MUST_NOT_ESCAPE_RESPONSE_LOSS");
        }
      });
      assert.equal(lost.status, "uncertain");
      assert.equal(lost.response_received, false);
      assert.equal(
        JSON.stringify(lost).includes("MUST_NOT_ESCAPE_RESPONSE_LOSS"),
        false
      );
      const descriptor = compileVerificationProbe({
        schema_version: "1.0.0",
        capability_id: "filesystem.apply_patch",
        capability_revision: "patch-v1",
        kind: "lookup_by_idempotency_key",
        probe: {
          capability_id: "filesystem.patch.lookup",
          capability_revision: "lookup-v1",
          effect_class: "observe"
        },
        arguments: [{
          name: "idempotency_key",
          source: "idempotency_key"
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
          total_timeout_ms: 100,
          max_result_bytes: 4096,
          initial_backoff_ms: 0,
          max_backoff_ms: 0,
          observation_window_ms: 0
        },
        evidence: {
          trust_level: "qualified_probe",
          redaction: "digest_only"
        },
        qualification_evidence_digest: ARTIFACT_DIGEST
      });
      const completed = await allowJournal.reconcile({
        operationId: "operation-allowed",
        descriptor,
        idempotency: lost.idempotency,
        invoke: async ({ arguments: lookup }) => {
          const record = backend.get(lookup.idempotency_key);
          return {
            data: record
              ? {
                status: "found",
                intent_digest: record.intent_digest
              }
              : { status: "not_found" },
            evidence_ref: record?.backend_reference ??
              "patch://docs/guide/absent",
            evidence_digest: ARTIFACT_DIGEST
          };
        },
        probeNow: () => 0
      });
      assert.equal(completed.state, "verified_committed");
      assert.equal(writeCount, 1);
      assert.equal(duplicateWriteCount, 0);
      assert.deepEqual(
        allowJournal.load("operation-allowed").events.map(
          ({ new_state: state }) => state
        ),
        [
          "planned", "preflighted", "admitted", "executing", "uncertain",
          "reconciling", "verified_committed"
        ]
      );
    } finally {
      allowJournal.close();
    }
    assert.throws(() => prepare({
      transaction: { admitTool: () => prepared.admission }
    }), TypeError);

    const driftedPolicy = compilePolicy({
      policyId: "skill-protected",
      rules: [{
        id: "ask-other-capsule",
        match: { ...match, capsule_digest: ARTIFACT_DIGEST },
        decision: "ask"
      }]
    });
    assert.throws(() => prepare({ policy: driftedPolicy }), (error) =>
      error instanceof EffectAdmissionError &&
      error.code === "EG_EFFECT_ADMISSION_DENIED" &&
      error.safeReasonCode === "policy_default_deny");

    transaction.reportPhaseOutcome({
      capsuleDigest: capsule.capsule_digest,
      status: "completed"
    });
    assertCode("EG_PHASE_TRANSITION_DENIED", prepare);
  } finally {
    files.close();
  }
});
