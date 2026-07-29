import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { BYTE_PROXY_COUNTER } from "../budget/token-counter.mjs";
import { TokenLedger } from "../budget/token-ledger.mjs";
import { compileIdempotencyAdapter } from "../policy/idempotency-adapter.mjs";
import { EffectOperationJournal } from "../policy/operation-journal.mjs";
import { completePhaseEffectOperation, dispatchPhaseEffectOperation,
  planPhaseEffectOperation } from "../policy/phase-effect-admission.mjs";
import { compilePolicy } from "../policy/policy-compiler.mjs";
import { compileVerificationProbe } from "../policy/verification-probe.mjs";
import { compileInstructionCapsule } from "../skill/capsule-compiler.mjs";
import { compileSkillPassport } from "../skill/passport-compiler.mjs";
import { SkillTransaction } from "../skill/phase-transaction.mjs";
import { SkillEventStore } from "../skill/skill-event-store.mjs";
import { SkillRpc } from "../skill/skill-rpc.mjs";
import { importSkillSource } from "../skill/source-import.mjs";
import { SkillRpcClient } from "../testkit/skill-rpc-client.mjs";
import {
  SKILL_BENCHMARK_PROFILES,
  runPairedBenchmark
} from "./paired-harness.mjs";
const NOW = Date.parse("2026-07-28T00:00:00.000Z");
const EMPTY_TOKENS = BYTE_PROXY_COUNTER.measure({ content: "" });
const PROMPT = "Inspect the seeded document using the document-editor skill.";

const digest = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

const IDEMPOTENCY_ADAPTER = compileIdempotencyAdapter({
  schema_version: "1.0.0",
  capability_id: "filesystem.apply_patch",
  capability_revision: "patch-v1",
  key_placement: { target: "headers", name: "Idempotency-Key" },
  lookup: {
    capability_id: "filesystem.patch.lookup",
    capability_revision: "lookup-v1",
    key_argument: "idempotency_key"
  },
  qualified_scenarios: ["same_key_same_intent",
    "same_key_different_intent", "concurrent_duplicate_calls",
    "server_restart", "response_loss_after_commit"],
  qualification_evidence_digest: digest("s3-idempotency-qualification")
});
const VERIFICATION_PROBE = compileVerificationProbe({
  schema_version: "1.0.0",
  capability_id: "filesystem.apply_patch",
  capability_revision: "patch-v1",
  kind: "lookup_by_idempotency_key",
  probe: {
    capability_id: "filesystem.patch.lookup",
    capability_revision: "lookup-v1",
    effect_class: "observe"
  },
  arguments: [{ name: "idempotency_key", source: "idempotency_key" }],
  predicates: {
    committed: [
      { path: "/status", equals: { literal: "found" } },
      { path: "/intent_digest", equals: { source: "intent_digest" } }
    ],
    not_committed: [{ path: "/status", equals: { literal: "not_found" } }],
    ambiguous: [{ path: "/status", equals: { literal: "ambiguous" } }]
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
  evidence: { trust_level: "qualified_probe", redaction: "digest_only" },
  qualification_evidence_digest: digest("s3-probe-qualification")
});

function seedSkill(workspace) {
  const root = join(workspace, "skill");
  const files = {
    "SKILL.md": "Never replace the original before verification.\n",
    "phases/inspect.md": "Inspect the input and report exact findings.\n",
    "phases/modify.md": "Apply only the admitted patch.\n",
    "phases/verify.md": "Verify the committed content before completion.\n",
    "references/inspect.md": "Inspection reference.\n".repeat(256)
  };
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, text, { flag: "wx", mode: 0o600 });
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
        dependency_refs: ["references/inspect.md"],
        allowed_tools: ["filesystem.read"],
        allowed_effect_classes: ["observe"],
        transition: { on_success: "modify" }
      },
      modify: {
        instruction_refs: ["phases/modify.md"],
        allowed_tools: ["filesystem.apply_patch"],
        allowed_effect_classes: ["mutate_reversible"],
        transition: { on_success: "verify" }
      },
      verify: {
        instruction_refs: ["phases/verify.md"],
        allowed_tools: ["filesystem.read"],
        allowed_effect_classes: ["observe"]
      }
    },
    declaredTools: ["filesystem.read", "filesystem.apply_patch"],
    declaredEffectClasses: ["observe", "mutate_reversible"]
  });
  return {
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

function capsule(skill, phase, phaseRevision) {
  return compileInstructionCapsule({
    passport: skill.passport,
    source: skill.source,
    phase,
    capabilities: skill.capabilities,
    phaseRevision,
    maxTokens: 10_000,
    maxBytes: 50_000,
    expiresAt: "2026-07-29T00:00:00.000Z"
  });
}

function metricBase(startedAt, visible) {
  return {
    task_success: true,
    latency_ms: performance.now() - startedAt,
    fetch_count: 0,
    tool_call_count: 0,
    tool_schema_tokens: EMPTY_TOKENS,
    tool_result_tokens: EMPTY_TOKENS,
    total_input_tokens: BYTE_PROXY_COUNTER.measure({
      content: visible.map(JSON.stringify).join("\n")
    }),
    compatibility: { native_deferral: "not_applicable" },
    instruction_fetch_count: 0,
    instruction_fetch_tokens: EMPTY_TOKENS,
    phase_receipt_tokens: EMPTY_TOKENS,
    verification_tokens: EMPTY_TOKENS,
    wrong_skill_selection: false,
    wrong_phase_transition: false,
    safety_invariant_available: true,
    protected_effect_policy_violations: 0,
    duplicate_write_count: 0
  };
}

const measureVisible = (values) => BYTE_PROXY_COUNTER.measure({
  content: values.map(JSON.stringify).join("\n")
});

function recordTokens(
  ledger, values, stage, category, direction = "to_host"
) {
  const content = values.map(JSON.stringify).join("\n");
  const tokenCount = BYTE_PROXY_COUNTER.measure({ content });
  ledger.append({
    stage,
    direction,
    tokenCount,
    bytes: Buffer.byteLength(content),
    category
  });
  return tokenCount;
}

async function runS3Profile(context, skill, workspace, startedAt) {
  const store = new SkillEventStore({
    file: join(workspace, `${context.runId}-skill.db`)
  });
  const journal = new EffectOperationJournal({
    file: join(workspace, `${context.runId}-effect.db`),
    now: () => NOW,
    monotonic: () => 1000
  });
  const ledger = new TokenLedger({
    file: join(workspace, `${context.runId}.jsonl`),
    runId: context.runId,
    sessionId: context.pairId,
    profile: context.ledgerProfile,
    now: () => NOW
  });
  try {
    const transaction = new SkillTransaction({
      transactionId: context.runId,
      passport: skill.passport,
      initialPhase: "inspect",
      eventStore: store,
      now: () => NOW
    });
    const inspect = capsule(skill, "inspect", 1);
    transaction.activateCapsule(inspect);
    let wrongPhaseDenied = false;
    try {
      transaction.admitTool({
        capsule: inspect,
        capsuleDigest: inspect.capsule_digest,
        capabilityId: "filesystem.apply_patch",
        capabilityRevision: "patch-v1",
        effectClass: "mutate_reversible"
      });
    } catch (error) {
      wrongPhaseDenied = error.code === "EG_PHASE_TOOL_NOT_ALLOWED";
    }
    transaction.admitTool({
      capsule: inspect,
      capsuleDigest: inspect.capsule_digest,
      capabilityId: "filesystem.read",
      capabilityRevision: "read-v1",
      effectClass: "observe"
    });
    const inspectReceipt = transaction.reportPhaseOutcome({
      capsuleDigest: inspect.capsule_digest,
      status: "completed",
      findingRefs: ["artifact://s3/inspect"]
    });

    const modify = capsule(skill, "modify", 2);
    transaction.activateCapsule(modify);
    const match = {
      skill_id: skill.passport.skill.id,
      skill_digest: skill.passport.skill.source_digest,
      phase: "modify",
      phase_revision: 2,
      capsule_digest: modify.capsule_digest,
      capability_id: "filesystem.apply_patch",
      capability_revision: "patch-v1",
      effect_class: "mutate_reversible"
    };
    const policy = compilePolicy({
      policyId: "s3-fixture",
      rules: [{ id: "allow-seeded-patch", match, decision: "allow" }]
    });
    const patch = {
      path: "docs/guide.md",
      content: "Verified fixture content.\n"
    };
    const effect = {
      transaction,
      capsule: modify,
      capsuleDigest: modify.capsule_digest,
      capabilityId: "filesystem.apply_patch",
      capabilityRevision: "patch-v1",
      effectClass: "mutate_reversible",
      policy,
      principalId: "principal-fixture",
      clientId: "effectgate-s3-fixture",
      sessionId: context.pairId,
      arguments: patch,
      resourceScope: {
        kind: "exact", value: "repo:fixture/path:docs/guide.md"
      },
      disclosureDigest: digest("s3-disclosure"),
      expiresAt: "2026-07-28T00:05:00.000Z",
      now: () => NOW
    };
    const operationId = `${context.runId}-effect`;
    const planned = planPhaseEffectOperation({
      operationId,
      journal,
      effect
    });
    const backend = new Map();
    let writes = 0;
    let duplicates = 0;
    const lost = await dispatchPhaseEffectOperation({
      operationId,
      journal,
      effect,
      adapter: IDEMPOTENCY_ADAPTER,
      request: { arguments: patch, headers: {} },
      deadlineAt: "2026-07-28T00:01:00.000Z",
      invoke: async (request) => {
        const key = request.headers["Idempotency-Key"];
        if (backend.has(key)) {
          duplicates += 1;
        } else {
          writes += 1;
          backend.set(key, {
            intent_digest: planned.intent.intent_digest,
            content: patch.content
          });
        }
        throw new Error("seeded response loss after commit");
      }
    });
    const verified = await journal.reconcile({
      operationId,
      descriptor: VERIFICATION_PROBE,
      idempotency: lost.idempotency,
      invoke: async ({ arguments: lookup }) => {
        const record = backend.get(lookup.idempotency_key);
        return {
          data: record
            ? { status: "found", intent_digest: record.intent_digest }
            : { status: "not_found" },
          evidence_ref: "evidence://s3/idempotency-lookup",
          evidence_digest: digest("s3-idempotency-lookup")
        };
      },
      probeNow: () => 0
    });
    const completion = completePhaseEffectOperation({
      operationId,
      receiptId: `${context.runId}-receipt`,
      journal,
      transaction
    });

    const verify = capsule(skill, "verify", 3);
    transaction.activateCapsule(verify);
    transaction.admitTool({
      capsule: verify,
      capsuleDigest: verify.capsule_digest,
      capabilityId: "filesystem.read",
      capabilityRevision: "read-v1",
      effectClass: "observe"
    });
    const committed = [...backend.values()][0];
    const verifyReceipt = transaction.reportPhaseOutcome({
      capsuleDigest: verify.capsule_digest,
      status: "completed",
      inputArtifactDigests: [digest(committed.content)],
      findingRefs: ["evidence://s3/content-verified"]
    });
    const phaseReceipts = transaction.receipts();
    const reference = skill.source.files.find(
      ({ path }) => path === "references/inspect.md"
    );
    const visible = [
      { id: skill.passport.skill.id },
      skill.passport,
      inspect,
      reference,
      inspectReceipt,
      modify,
      completion.effect_receipt,
      completion.phase_receipt,
      verify,
      verifyReceipt
    ];
    const skillCatalogTokens = recordTokens(
      ledger, visible.slice(0, 2), "skill_catalog",
      "skill_catalog_tokens_emitted"
    );
    const skillInstructionTokens = recordTokens(
      ledger, [inspect, modify, verify], "skill_instruction",
      "skill_instruction_tokens_emitted"
    );
    const instructionFetchTokens = recordTokens(
      ledger, [reference], "instruction_dependency",
      "instruction_dependency_fetch_tokens"
    );
    const phaseReceiptTokens = recordTokens(
      ledger, phaseReceipts, "phase_receipt",
      "phase_receipt_tokens_emitted"
    );
    const verificationTokens = recordTokens(
      ledger,
      [verified.reconciliation, completion.effect_receipt],
      "verification",
      "verification_overhead_tokens",
      "internal"
    );
    ledger.verify();
    return {
      ...metricBase(startedAt, visible),
      task_success:
        wrongPhaseDenied &&
        lost.status === "uncertain" &&
        verified.state === "verified_committed" &&
        completion.phase_receipt.next_phase === "verify" &&
        transaction.snapshot().status === "completed" &&
        writes === 1 &&
        duplicates === 0,
      fetch_count: 1,
      tool_call_count: 3,
      skill_catalog_tokens: skillCatalogTokens,
      skill_instruction_tokens: skillInstructionTokens,
      instruction_fetch_count: 1,
      instruction_fetch_tokens: instructionFetchTokens,
      phase_receipt_tokens: phaseReceiptTokens,
      verification_tokens: verificationTokens,
      wrong_phase_transition: !wrongPhaseDenied,
      duplicate_write_count: duplicates
    };
  } finally {
    ledger.close();
    journal.close();
    store.close();
  }
}

async function runProfile(context, skill, workspace) {
  const startedAt = performance.now();
  if (context.profile === "S1_FULL_LOAD_DIAGNOSTIC") {
    const catalog = { id: skill.passport.skill.id };
    const instructions = skill.source.files.map(({ text }) => text).join("");
    return {
      ...metricBase(startedAt, [catalog, instructions]),
      skill_catalog_tokens: BYTE_PROXY_COUNTER.measure({
        content: JSON.stringify(catalog)
      }),
      skill_instruction_tokens: BYTE_PROXY_COUNTER.measure({
        content: instructions
      })
    };
  }
  if (context.profile === "S3_EG_CAPSULE_VERIFIED") {
    return runS3Profile(context, skill, workspace, startedAt);
  }

  const store = new SkillEventStore({
    file: join(workspace, `${context.runId}.db`)
  });
  const ledger = new TokenLedger({
    file: join(workspace, `${context.runId}.jsonl`),
    runId: context.runId,
    sessionId: context.pairId,
    profile: context.ledgerProfile,
    now: () => NOW
  });
  try {
    const client = new SkillRpcClient(new SkillRpc({
      skills: [skill], eventStore: store, tokenLedger: ledger, now: () => NOW
    }));
    const visible = [];
    visible.push(client.request("skills/list"));
    visible.push(client.request("skills/passport/get", {
      skill_id: "document-editor"
    }));
    client.request("skills/transaction/start", {
      transaction_id: context.runId,
      skill_id: "document-editor",
      initial_phase: "inspect"
    });
    const capsule = client.request("skills/capsule/get", {
      transaction_id: context.runId
    });
    visible.push(capsule);
    let wrongPhaseDenied = false;
    try {
      client.request("skills/tool/admit", {
        transaction_id: context.runId,
        capsule_digest: capsule.capsule_digest,
        capability_id: "filesystem.apply_patch",
        capability_revision: "patch-v1",
        effect_class: "mutate_reversible"
      });
    } catch (error) {
      wrongPhaseDenied = error.effectgateCode === "EG_PHASE_TOOL_NOT_ALLOWED";
    }
    client.request("skills/tool/admit", {
      transaction_id: context.runId,
      capsule_digest: capsule.capsule_digest,
      capability_id: "filesystem.read",
      capability_revision: "read-v1",
      effect_class: "observe"
    });
    visible.push(client.request("skills/dependency/get", {
      transaction_id: context.runId,
      source_ref: "references/inspect.md"
    }));
    const receipt = client.request("skills/phase/report", {
      transaction_id: context.runId,
      capsule_digest: capsule.capsule_digest,
      status: "completed"
    });
    visible.push(receipt);
    const base = metricBase(startedAt, visible);
    return {
      ...base,
      task_success:
        wrongPhaseDenied &&
        capsule.invariants.some(({ id }) => id === "preserve-original") &&
        receipt.next_phase === "modify",
      fetch_count: 1,
      skill_catalog_tokens: measureVisible(visible.slice(0, 2)),
      skill_instruction_tokens: measureVisible([capsule]),
      instruction_fetch_count: 1,
      instruction_fetch_tokens: measureVisible([visible[3]]),
      phase_receipt_tokens: measureVisible([receipt]),
      wrong_phase_transition: !wrongPhaseDenied
    };
  } finally {
    ledger.close();
    store.close();
  }
}

export async function runSkillFixtureBenchmark({
  file,
  workspace,
  repetitions = 1,
  seed = "effectgate-skill-context-v1"
} = {}) {
  if (
    typeof workspace !== "string" ||
    workspace.length < 1 ||
    workspace.length > 1024 ||
    Buffer.byteLength(workspace, "utf8") > 4096 ||
    workspace.includes("\0")
  ) {
    throw new TypeError("invalid Skill benchmark workspace");
  }
  const skill = seedSkill(workspace);
  return runPairedBenchmark({
    file,
    taskId: "BENCH-SKILL-CONTEXT-001",
    seed,
    repetitions,
    backendDigest: skill.source.source_digest,
    promptDigest: digest(PROMPT),
    rubricDigest: digest("correct discovery, invariant, phase and admission"),
    model: "deterministic-fixture",
    effort: "none",
    hostVersion: "effectgate-skill-fixture-1",
    machineClass: `${platform()}-${arch()}`,
    profiles: SKILL_BENCHMARK_PROFILES,
    runProfile: (context) => runProfile(context, skill, workspace)
  });
}
