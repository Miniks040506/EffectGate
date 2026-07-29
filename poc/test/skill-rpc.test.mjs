import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { compileEffectIntent } from "../src/policy/effect-intent.mjs";
import {
  EffectOperationJournal
} from "../src/policy/operation-journal.mjs";
import {
  compileVerificationProbe
} from "../src/policy/verification-probe.mjs";
import { compileSkillPassport } from "../src/skill/passport-compiler.mjs";
import { TokenLedger } from "../src/budget/token-ledger.mjs";
import { SkillEventStore } from "../src/skill/skill-event-store.mjs";
import { SkillRpc } from "../src/skill/skill-rpc.mjs";
import { importSkillSource } from "../src/skill/source-import.mjs";
import { SkillRpcClient } from "../src/testkit/skill-rpc-client.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "effectgate-rpc-"));
  const files = {
    "SKILL.md": "Preserve the original.\n",
    "phases/inspect.md": "Inspect the input.\n",
    "phases/modify.md": "Apply the admitted change.\n"
  };
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const source = importSkillSource({ root, paths: Object.keys(files) });
  const passport = compileSkillPassport({
    source,
    skill: {
      id: "document-editor",
      version: "1.0.0",
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
        allowed_tools: ["filesystem.read"],
        allowed_effect_classes: ["observe"],
        transition: { on_success: "modify" }
      },
      modify: {
        instruction_refs: ["phases/modify.md"],
        allowed_tools: ["filesystem.apply_patch"],
        allowed_effect_classes: ["mutate_reversible"]
      }
    },
    declaredTools: ["filesystem.read", "filesystem.apply_patch"],
    declaredEffectClasses: ["observe", "mutate_reversible"]
  });
  return {
    root,
    source,
    passport,
    capabilities: {
      "filesystem.read": { revision: "read-v1", effect_class: "observe" },
      "filesystem.apply_patch": {
        revision: "patch-v1",
        effect_class: "mutate_reversible"
      }
    }
  };
}

test("local Skill RPC drives and recovers a complete phase lifecycle", () => {
  const skill = fixture();
  const store = new SkillEventStore({ file: join(skill.root, "events.db") });
  let clock = Date.parse("2026-07-28T00:00:00.000Z");
  const now = () => clock;
  const ledgerFile = join(skill.root, "tokens.jsonl");
  const ledger = new TokenLedger({
    file: ledgerFile,
    runId: "skill-rpc-run",
    sessionId: "skill-rpc-session",
    now
  });
  try {
    let client = new SkillRpcClient(new SkillRpc({
      skills: [skill], eventStore: store, tokenLedger: ledger, now
    }));
    assert.equal(client.request("skills/list").skills[0].id, "document-editor");
    assert.equal(
      client.request("skills/passport/get", {
        skill_id: "document-editor"
      }).passport_digest,
      skill.passport.passport_digest
    );
    assert.equal(client.request("skills/transaction/start", {
      transaction_id: "rpc-transaction",
      skill_id: "document-editor",
      initial_phase: "inspect"
    }).status, "awaiting_capsule");

    const inspect = client.request("skills/capsule/get", {
      transaction_id: "rpc-transaction"
    });
    assert.equal(inspect.phase, "inspect");
    assert.deepEqual(client.request("skills/tool/admit", {
      transaction_id: "rpc-transaction",
      capsule_digest: inspect.capsule_digest,
      capability_id: "filesystem.read",
      capability_revision: "read-v1",
      effect_class: "observe"
    }), {
      schema_version: "1.0.0",
      transaction_id: "rpc-transaction",
      skill_id: "document-editor",
      skill_digest: skill.source.source_digest,
      phase: "inspect",
      phase_revision: 1,
      capsule_digest: inspect.capsule_digest,
      capability_id: "filesystem.read",
      capability_revision: "read-v1",
      effect_class: "observe"
    });
    for (const [overrides, code] of [
      [{ capability_id: "filesystem.apply_patch" },
        "EG_PHASE_TOOL_NOT_ALLOWED"],
      [{ capability_revision: "read-v2" }, "EG_PHASE_TOOL_NOT_ALLOWED"],
      [{ effect_class: "mutate_reversible" },
        "EG_PHASE_EFFECT_CLASS_NOT_ALLOWED"]
    ]) {
      assert.throws(() => client.request("skills/tool/admit", {
        transaction_id: "rpc-transaction",
        capsule_digest: inspect.capsule_digest,
        capability_id: "filesystem.read",
        capability_revision: "read-v1",
        effect_class: "observe",
        ...overrides
      }), (error) => error.effectgateCode === code);
    }
    assert.equal(client.request("skills/dependency/get", {
      transaction_id: "rpc-transaction",
      source_ref: "phases/inspect.md"
    }).text, "Inspect the input.\n");
    assert.throws(() => client.request("skills/dependency/get", {
      transaction_id: "rpc-transaction",
      source_ref: "phases/modify.md"
    }), (error) => error.effectgateCode === "EG_SKILL_DEPENDENCY_MISSING");

    client.request("skills/phase/report", {
      transaction_id: "rpc-transaction",
      capsule_digest: inspect.capsule_digest,
      status: "completed"
    });
    assert.throws(() => client.request("skills/tool/admit", {
      transaction_id: "rpc-transaction",
      capsule_digest: inspect.capsule_digest,
      capability_id: "filesystem.read",
      capability_revision: "read-v1",
      effect_class: "observe"
    }), (error) => error.effectgateCode === "EG_PHASE_TRANSITION_DENIED");
    const modify = client.request("skills/capsule/get", {
      transaction_id: "rpc-transaction"
    });

    client = new SkillRpcClient(new SkillRpc({
      skills: [skill], eventStore: store, tokenLedger: ledger, now
    }));
    assert.equal(client.request("skills/capsule/get", {
      transaction_id: "rpc-transaction"
    }).capsule_digest, modify.capsule_digest);
    clock += 6 * 60 * 1000;
    const renewed = client.request("skills/capsule/get", {
      transaction_id: "rpc-transaction"
    });
    assert.notEqual(renewed.capsule_digest, modify.capsule_digest);
    client.request("skills/phase/report", {
      transaction_id: "rpc-transaction",
      capsule_digest: renewed.capsule_digest,
      status: "aborted"
    });
    assert.equal(client.request("skills/receipts/list", {
      transaction_id: "rpc-transaction"
    }).receipts.length, 2);
    assert.throws(() => client.request("skills/capsule/get", {
      transaction_id: "rpc-transaction"
    }), (error) => error.effectgateCode === "EG_PHASE_TRANSITION_DENIED");
    assert.throws(() => client.request("unknown", {}),
      (error) => error.rpcCode === -32601);
    const entries = ledger.snapshot().entries;
    const categories = new Set(
      entries.map((entry) => entry.safe_metadata.category)
    );
    assert.deepEqual(categories, new Set([
      "skill_catalog_tokens_emitted",
      "skill_instruction_tokens_emitted",
      "skill_instruction_tokens_avoided",
      "instruction_dependency_fetch_tokens",
      "phase_receipt_tokens_emitted"
    ]));
    const avoided = entries.find((entry) =>
      entry.safe_metadata.category === "skill_instruction_tokens_avoided");
    assert.equal(avoided.direction, "counterfactual");
    assert.equal(avoided.safe_metadata.comparator, "full_skill_source");
    assert.equal(avoided.safe_metadata.source_digest, skill.source.source_digest);
    assert.doesNotMatch(
      readFileSync(ledgerFile, "utf8"),
      /Preserve the original|Inspect the input|Apply the admitted change/
    );
  } finally {
    ledger.close();
    store.close();
    rmSync(skill.root, { recursive: true, force: true });
  }
});

test("Skill RPC exposes only transaction-bound verified effect evidence", async () => {
  const skill = fixture();
  const now = Date.parse("2026-07-28T00:00:00.000Z");
  const store = new SkillEventStore({
    file: join(skill.root, "effect-events.db")
  });
  const journal = new EffectOperationJournal({
    file: join(skill.root, "effects.db"),
    now: () => now,
    monotonic: () => 1000
  });
  try {
    const client = new SkillRpcClient(new SkillRpc({
      skills: [skill],
      eventStore: store,
      effectJournal: journal,
      now: () => now
    }));
    client.request("skills/transaction/start", {
      transaction_id: "rpc-effect-owner",
      skill_id: "document-editor",
      initial_phase: "inspect"
    });
    const capsule = client.request("skills/capsule/get", {
      transaction_id: "rpc-effect-owner"
    });
    const intent = compileEffectIntent({
      principalId: "principal-local",
      clientId: "effectgate-rpc-test",
      sessionId: "rpc-effect-session",
      admission: {
        schema_version: "1.0.0",
        transaction_id: "rpc-effect-owner",
        skill_id: "document-editor",
        skill_digest: skill.source.source_digest,
        phase: "inspect",
        phase_revision: 1,
        capsule_digest: capsule.capsule_digest,
        capability_id: "filesystem.read",
        capability_revision: "read-v1",
        effect_class: "observe"
      },
      policyDecision: {
        decision: "allow",
        policy_revision: digest("a"),
        matched_rule_ids: ["allow-read"],
        safe_reason_code: "policy_allow"
      },
      arguments: { path: "MUST_NOT_ESCAPE_EFFECT_RPC" },
      resourceScope: {
        kind: "exact",
        value: "repo:fixture/path:docs/guide.md"
      },
      disclosureDigest: digest("b"),
      expiresAt: "2026-07-28T00:05:00.000Z",
      now: () => now
    });
    journal.plan({
      operationId: "rpc-effect-operation",
      intent,
      approvalRequired: false
    });
    journal.preflight("rpc-effect-operation");
    journal.admit("rpc-effect-operation");
    journal.beginDispatch({
      operationId: "rpc-effect-operation",
      dispatchDigest: digest("c"),
      deadlineAt: "2026-07-28T00:01:00.000Z"
    });
    journal.markUncertain({
      operationId: "rpc-effect-operation",
      evidenceRef: digest("d"),
      reason: "response_lost_after_dispatch"
    });
    const descriptor = compileVerificationProbe({
      schema_version: "1.0.0",
      capability_id: "filesystem.read",
      capability_revision: "read-v1",
      kind: "lookup_by_fingerprint",
      probe: {
        capability_id: "filesystem.read.lookup",
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
      qualification_evidence_digest: digest("e")
    });
    await journal.reconcile({
      operationId: "rpc-effect-operation",
      descriptor,
      invoke: async () => ({
        data: {
          status: "found",
          intent_digest: intent.intent_digest
        },
        evidence_ref: "evidence://rpc/read",
        evidence_digest: digest("f")
      }),
      probeNow: () => 0
    });
    const receipt = journal.issueReceipt({
      receiptId: "rpc-effect-receipt",
      operationId: "rpc-effect-operation"
    });

    const operation = client.request("skills/effect/operation/get", {
      transaction_id: "rpc-effect-owner",
      operation_id: "rpc-effect-operation"
    });
    assert.equal(operation.state, "verified_committed");
    assert.equal(operation.transaction_id, "rpc-effect-owner");
    assert.equal(
      JSON.stringify(operation).includes("MUST_NOT_ESCAPE_EFFECT_RPC"),
      false
    );
    assert.deepEqual(client.request("skills/effect/receipt/get", {
      transaction_id: "rpc-effect-owner",
      receipt_id: "rpc-effect-receipt"
    }), receipt);

    client.request("skills/transaction/start", {
      transaction_id: "rpc-effect-other",
      skill_id: "document-editor",
      initial_phase: "inspect"
    });
    for (const [method, params, code] of [
      [
        "skills/effect/operation/get",
        { operation_id: "rpc-effect-operation" },
        "EG_OPERATION_NOT_FOUND"
      ],
      [
        "skills/effect/receipt/get",
        { receipt_id: "rpc-effect-receipt" },
        "EG_RECEIPT_NOT_FOUND"
      ]
    ]) {
      assert.throws(() => client.request(method, {
        transaction_id: "rpc-effect-other",
        ...params
      }), (error) => error.effectgateCode === code);
    }
    const unavailable = new SkillRpcClient(new SkillRpc({
      skills: [skill],
      eventStore: store,
      now: () => now
    }));
    assert.throws(() => unavailable.request(
      "skills/effect/operation/get",
      {
        transaction_id: "rpc-effect-owner",
        operation_id: "rpc-effect-operation"
      }
    ), (error) =>
      error.effectgateCode === "EG_VERIFIED_EFFECT_UNAVAILABLE");
    assert.throws(() => new SkillRpc({
      skills: [skill],
      eventStore: store,
      effectJournal: { load: () => operation }
    }), TypeError);
  } finally {
    journal.close();
    store.close();
    rmSync(skill.root, { recursive: true, force: true });
  }
});
