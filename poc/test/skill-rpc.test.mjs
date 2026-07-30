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
  compileIdempotencyAdapter
} from "../src/policy/idempotency-adapter.mjs";
import {
  EffectOperationJournal
} from "../src/policy/operation-journal.mjs";
import { compilePolicy } from "../src/policy/policy-compiler.mjs";
import {
  compileVerificationProbe
} from "../src/policy/verification-probe.mjs";
import { MCP_VERSION } from "../src/proxy/mcp-contract.mjs";
import { compileSkillPassport } from "../src/skill/passport-compiler.mjs";
import { TokenLedger } from "../src/budget/token-ledger.mjs";
import { SkillMcp } from "../src/skill/skill-mcp.mjs";
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

test("Skill RPC runs only runtime-owned verified effect commands", async () => {
  const skill = fixture();
  const now = Date.parse("2026-07-28T00:00:00.000Z");
  const store = new SkillEventStore({
    file: join(skill.root, "command-events.db")
  });
  let journal = new EffectOperationJournal({
    file: join(skill.root, "command-effects.db"),
    now: () => now,
    monotonic: () => 1000
  });
  try {
    const setup = new SkillRpcClient(new SkillRpc({
      skills: [skill],
      eventStore: store,
      effectJournal: journal,
      now: () => now
    }));
    setup.request("skills/transaction/start", {
      transaction_id: "rpc-command-owner",
      skill_id: "document-editor",
      initial_phase: "modify"
    });
    const capsule = setup.request("skills/capsule/get", {
      transaction_id: "rpc-command-owner"
    });
    const match = {
      skill_id: "document-editor",
      skill_digest: skill.source.source_digest,
      phase: "modify",
      phase_revision: 1,
      capsule_digest: capsule.capsule_digest,
      capability_id: "filesystem.apply_patch",
      capability_revision: "patch-v1",
      effect_class: "mutate_reversible"
    };
    const policy = compilePolicy({
      policyId: "rpc-command",
      rules: [{ id: "allow-patch", match, decision: "allow" }]
    });
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
      qualification_evidence_digest: digest("a")
    });
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
        committed: [{ path: "/status", equals: { literal: "found" } }],
        not_committed: [{
          path: "/status",
          equals: { literal: "not_found" }
        }],
        ambiguous: [{
          path: "/status",
          equals: { literal: "ambiguous" }
        }]
      },
      limits: {
        max_attempts: 2,
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
      qualification_evidence_digest: digest("b")
    });
    const backend = new Set();
    let writes = 0;
    let dispatchStarted;
    const interruptedDispatch = new Promise((resolve) => {
      dispatchStarted = resolve;
    });
    let ambiguousDispatchStarted;
    const ambiguousDispatch = new Promise((resolve) => {
      ambiguousDispatchStarted = resolve;
    });
    const ambiguous = new Set();
    const command = {
      policy,
      adapter,
      descriptor,
      principalId: "principal-local",
      clientId: "effectgate-rpc",
      effectClass: "mutate_reversible",
      tool: {
        name: "effectgate_apply_patch",
        title: "Apply Verified Patch",
        description: "Applies and verifies one phase-bound patch.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["patch"],
          properties: {
            patch: { type: "string", maxLength: 4096 }
          }
        }
      },
      validate: (argumentsValue) =>
        typeof argumentsValue?.patch === "string",
      invoke: async (request) => {
        if (request.arguments.patch !== "DO_NOT_COMMIT") {
          writes += 1;
          const key = request.headers["Idempotency-Key"];
          if (request.arguments.patch === "INTERRUPT_AMBIGUOUS") {
            ambiguous.add(key);
            ambiguousDispatchStarted();
            await new Promise(() => {});
          }
          backend.add(key);
          if (request.arguments.patch === "INTERRUPT_AFTER_COMMIT") {
            dispatchStarted();
            await new Promise(() => {});
          }
        }
      },
      verify: async ({ arguments: lookup }) => ({
        data: {
          status: ambiguous.has(lookup.idempotency_key)
            ? "ambiguous"
            : backend.has(lookup.idempotency_key)
              ? "found"
              : "not_found"
        },
        evidence_ref: "evidence://rpc/patch",
        evidence_digest: digest("c")
      })
    };
    const rpc = new SkillRpc({
      skills: [skill],
      eventStore: store,
      effectJournal: journal,
      effectCommands: [command],
      now: () => now
    });
    const client = new SkillRpcClient(rpc);
    const params = {
      transaction_id: "rpc-command-owner",
      operation_id: "rpc-command-operation",
      receipt_id: "rpc-command-receipt",
      capsule_digest: capsule.capsule_digest,
      capability_id: "filesystem.apply_patch",
      capability_revision: "patch-v1",
      effect_class: "mutate_reversible",
      arguments: { patch: "MUST_NOT_ESCAPE_EFFECT_COMMAND" },
      resource_scope: {
        kind: "exact",
        value: "repo:fixture/path:docs/guide.md"
      },
      disclosure_digest: digest("d")
    };
    await assert.rejects(
      client.requestAsync("skills/effect/execute", {
        ...params,
        operation_id: "rpc-command-injected",
        policy: { decision: "allow" }
      }),
      (error) => error.effectgateCode === "EG_EFFECT_COMMAND_INVALID"
    );
    assert.equal(journal.load("rpc-command-injected"), undefined);

    const result = await client.requestAsync(
      "skills/effect/execute",
      params
    );
    assert.equal(result.status, "completed");
    assert.equal(result.effect_receipt.final_state, "verified_committed");
    assert.deepEqual(result.phase_receipt.effect_receipt_refs, [
      "receipt://effect/rpc-command-receipt"
    ]);
    assert.equal(writes, 1);
    assert.equal(
      JSON.stringify(result).includes("MUST_NOT_ESCAPE_EFFECT_COMMAND"),
      false
    );
    assert.deepEqual(
      journal.load("rpc-command-operation").events.map(
        ({ new_state: state }) => state
      ),
      [
        "planned", "preflighted", "admitted", "executing", "uncertain",
        "reconciling", "verified_committed"
      ]
    );
    assert.equal(client.request("skills/transaction/get", {
      transaction_id: "rpc-command-owner"
    }).status, "completed");

    client.request("skills/transaction/start", {
      transaction_id: "rpc-command-not-committed",
      skill_id: "document-editor",
      initial_phase: "modify"
    });
    const retained = client.request("skills/capsule/get", {
      transaction_id: "rpc-command-not-committed"
    });
    assert.equal(retained.capsule_digest, capsule.capsule_digest);
    const publishedArguments = {
      transaction_id: "rpc-command-not-committed",
      operation_id: "rpc-command-absent",
      receipt_id: "rpc-command-absent-receipt",
      capsule_digest: retained.capsule_digest,
      arguments: { patch: "DO_NOT_COMMIT" },
      resource_scope: params.resource_scope,
      disclosure_digest: params.disclosure_digest
    };
    const mcp = new SkillMcp(rpc);
    const initialized = await mcp.dispatch({
      jsonrpc: "2.0",
      id: "initialize",
      method: "initialize",
      params: { protocolVersion: MCP_VERSION }
    });
    assert.equal(initialized.result.protocolVersion, MCP_VERSION);
    await mcp.dispatch({
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    });
    const unlisted = await mcp.dispatch({
      jsonrpc: "2.0",
      id: "unlisted",
      method: "tools/call",
      params: {
        name: "effectgate_apply_patch",
        arguments: {
          ...publishedArguments,
          operation_id: "rpc-command-unlisted"
        }
      }
    });
    assert.equal(unlisted.error.code, -32602);
    assert.equal(journal.load("rpc-command-unlisted"), undefined);
    const listed = await mcp.dispatch({
      jsonrpc: "2.0",
      id: "list",
      method: "tools/list",
      params: {}
    });
    assert.equal(listed.result.tools[0].name, "effectgate_apply_patch");
    assert.equal(listed.result.tools[0].annotations.readOnlyHint, false);
    assert.equal(
      JSON.stringify(listed).includes("capability_revision"),
      false
    );
    const injected = await mcp.dispatch({
      jsonrpc: "2.0",
      id: "injected",
      method: "tools/call",
      params: {
        name: "effectgate_apply_patch",
        arguments: {
          ...publishedArguments,
          operation_id: "rpc-command-mcp-injected",
          effect_class: "observe"
        }
      }
    });
    assert.equal(injected.error.code, -32602);
    assert.equal(journal.load("rpc-command-mcp-injected"), undefined);
    const denied = await mcp.dispatch({
      jsonrpc: "2.0",
      id: "denied",
      method: "tools/call",
      params: {
        name: "effectgate_apply_patch",
        arguments: {
          ...publishedArguments,
          operation_id: "rpc-command-mcp-denied",
          capsule_digest: digest("f"),
          arguments: { patch: "MUST_NOT_ESCAPE_MCP_ERROR" }
        }
      }
    });
    assert.equal(denied.result.isError, true);
    assert.match(
      denied.result.structuredContent.effectgate_code,
      /^EG_/u
    );
    assert.equal(
      JSON.stringify(denied).includes("MUST_NOT_ESCAPE_MCP_ERROR"),
      false
    );
    assert.equal(journal.load("rpc-command-mcp-denied"), undefined);
    const notCommittedResponse = await mcp.dispatch({
      jsonrpc: "2.0",
      id: "call",
      method: "tools/call",
      params: {
        name: "effectgate_apply_patch",
        arguments: publishedArguments
      }
    });
    const notCommitted = notCommittedResponse.result.structuredContent;
    assert.equal(notCommitted.status, "verified_not_committed");
    assert.equal(notCommittedResponse.result.isError, false);
    assert.equal(
      JSON.stringify(notCommittedResponse).includes("DO_NOT_COMMIT"),
      false
    );
    assert.equal(
      journal.loadReceipt("rpc-command-absent-receipt"),
      undefined
    );
    assert.equal(client.request("skills/transaction/get", {
      transaction_id: "rpc-command-not-committed"
    }).status, "active");
    assert.equal(client.request("skills/capsule/get", {
      transaction_id: "rpc-command-not-committed"
    }).capsule_digest, retained.capsule_digest);

    client.request("skills/transaction/start", {
      transaction_id: "rpc-command-restart",
      skill_id: "document-editor",
      initial_phase: "modify"
    });
    const restartCapsule = client.request("skills/capsule/get", {
      transaction_id: "rpc-command-restart"
    });
    void client.requestAsync("skills/effect/execute", {
      ...params,
      transaction_id: "rpc-command-restart",
      operation_id: "rpc-command-interrupted",
      receipt_id: "rpc-command-interrupted-request",
      capsule_digest: restartCapsule.capsule_digest,
      arguments: { patch: "INTERRUPT_AFTER_COMMIT" }
    });
    await interruptedDispatch;
    assert.equal(
      journal.load("rpc-command-interrupted").operation.state,
      "executing"
    );
    journal.close();
    const recoveredNow = now + 6 * 60 * 1000;
    journal = new EffectOperationJournal({
      file: join(skill.root, "command-effects.db"),
      now: () => recoveredNow,
      monotonic: () => 1000
    });
    const recoveredRpc = new SkillRpc({
      skills: [skill],
      eventStore: store,
      effectJournal: journal,
      effectCommands: [command],
      now: () => recoveredNow
    });
    const recovery = await recoveredRpc.recoverEffects();
    assert.deepEqual(recovery.startup, [{
      operation_id: "rpc-command-interrupted",
      previous_state: "executing",
      state: "uncertain",
      certainty: "commit_possible",
      recovery_reason: "startup_dispatch_uncertain"
    }]);
    const recovered = recovery.outcomes.find(({ operation_id: id }) =>
      id === "rpc-command-interrupted");
    assert.equal(recovered.state, "verified_committed");
    assert.match(recovered.receipt_id, /^recovery-[a-f0-9]{64}$/u);
    assert.equal(
      journal.loadReceipt(recovered.receipt_id).operation_id,
      "rpc-command-interrupted"
    );
    const recoveredClient = new SkillRpcClient(recoveredRpc);
    assert.equal(recoveredClient.request("skills/transaction/get", {
      transaction_id: "rpc-command-restart"
    }).status, "completed");
    const reopenedClient = new SkillRpcClient(new SkillRpc({
      skills: [skill],
      eventStore: store,
      effectJournal: journal,
      now: () => recoveredNow
    }));
    assert.equal(reopenedClient.request("skills/transaction/get", {
      transaction_id: "rpc-command-restart"
    }).status, "completed");
    assert.equal(writes, 2);

    recoveredClient.request("skills/transaction/start", {
      transaction_id: "rpc-command-manual",
      skill_id: "document-editor",
      initial_phase: "modify"
    });
    const manualCapsule = recoveredClient.request("skills/capsule/get", {
      transaction_id: "rpc-command-manual"
    });
    const manualCommand = {
      ...command,
      policy: compilePolicy({
        policyId: "rpc-command-manual",
        rules: [{
          id: "allow-patch",
          match: {
            ...match,
            capsule_digest: manualCapsule.capsule_digest
          },
          decision: "allow"
        }]
      })
    };
    const manualClient = new SkillRpcClient(new SkillRpc({
      skills: [skill],
      eventStore: store,
      effectJournal: journal,
      effectCommands: [manualCommand],
      now: () => recoveredNow
    }));
    void manualClient.requestAsync("skills/effect/execute", {
      ...params,
      transaction_id: "rpc-command-manual",
      operation_id: "rpc-command-ambiguous",
      receipt_id: "rpc-command-ambiguous-request",
      capsule_digest: manualCapsule.capsule_digest,
      arguments: { patch: "INTERRUPT_AMBIGUOUS" }
    });
    await ambiguousDispatch;
    journal.close();
    journal = new EffectOperationJournal({
      file: join(skill.root, "command-effects.db"),
      now: () => recoveredNow + 1000,
      monotonic: () => 1000
    });
    const blockedRpc = new SkillRpc({
      skills: [skill],
      eventStore: store,
      effectJournal: journal,
      effectCommands: [manualCommand],
      now: () => recoveredNow + 1000
    });
    assert.equal(
      journal.recover()[0].state,
      "uncertain"
    );
    const stillUncertain = await blockedRpc.reconcileEffect(
      "rpc-command-ambiguous"
    );
    assert.equal(stillUncertain.state, "reconciling");
    ambiguous.clear();
    const provedAbsent = await blockedRpc.reconcileEffect(
      "rpc-command-ambiguous"
    );
    assert.equal(provedAbsent.state, "verified_not_committed");
    assert.equal(
      journal.load("rpc-command-ambiguous").operation.state,
      "verified_not_committed"
    );
    assert.equal(writes, 3);
  } finally {
    journal.close();
    store.close();
    rmSync(skill.root, { recursive: true, force: true });
  }
});
