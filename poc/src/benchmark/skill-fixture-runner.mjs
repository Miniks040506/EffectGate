import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { BYTE_PROXY_COUNTER } from "../budget/token-counter.mjs";
import { TokenLedger } from "../budget/token-ledger.mjs";
import { compileSkillPassport } from "../skill/passport-compiler.mjs";
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

function runProfile(context, skill, workspace) {
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
    const error = new Error("verified effect lifecycle is not implemented");
    error.code = "verified_effect_unavailable";
    throw error;
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
