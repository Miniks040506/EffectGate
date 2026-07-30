import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  loadLayeredConfiguration,
  normalizeEnvironmentSecretRefs,
  resolveEnvironmentSecretRefs
} from "../config/layered-config.mjs";
import {
  createOperatorRpcServer
} from "../operator/operator-rpc.mjs";
import {
  decideConfiguredApproval,
  inspectConfiguredApproval
} from "../operator/operator-state.mjs";
import { compileIdempotencyAdapter } from "../policy/idempotency-adapter.mjs";
import { ApprovalLeaseStore } from "../policy/approval-lease-store.mjs";
import { EffectOperationJournal } from "../policy/operation-journal.mjs";
import { compilePolicy } from "../policy/policy-compiler.mjs";
import { compileVerificationProbe } from "../policy/verification-probe.mjs";
import { SkillEventStore } from "./skill-event-store.mjs";
import { SkillMcp } from "./skill-mcp.mjs";
import { compileSkillPassport, deepFreeze } from "./passport-compiler.mjs";
import { SkillRpc } from "./skill-rpc.mjs";
import { importSkillSource } from "./source-import.mjs";
import {
  STDIO_EFFECT_DRIVER,
  createReviewedStdioEffectBackend
} from "./stdio-effect-adapter.mjs";

const MEMORY_DRIVER = "effectgate.fixture.memory-patch.v1";
const CONFIG_KEYS = [
  "schema_version", "driver", "state_directory", "skill_root",
  "skill_source_digest", "transaction_id", "principal_id", "client_id",
  "target_path", "resource_scope"
];
export const SKILL_SOURCE_PATHS = Object.freeze([
  "SKILL.md", "phases/modify.md"
]);
const TOOL_NAME = "effectgate_apply_verified_patch";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;

const digest = (value) =>
  `sha256:${createHash("sha256").update(value).digest("hex")}`;

function exactData(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function bounded(value, maximum) {
  return typeof value === "string" && value.length >= 1 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !value.includes("\0") && value === value.normalize("NFC");
}

export function normalizeSkillMcpConfig(value) {
  const stdio = value?.driver === STDIO_EFFECT_DRIVER;
  let secretRefs;
  try {
    secretRefs = value?.secret_refs === undefined
      ? undefined
      : normalizeEnvironmentSecretRefs(value.secret_refs);
  } catch {
    throw new TypeError("invalid Skill MCP configuration");
  }
  const keys = stdio
    ? [
        ...CONFIG_KEYS,
        "backend_source_digest",
        ...(value.approval_mode === undefined ? [] : ["approval_mode"]),
        ...(secretRefs === undefined ? [] : ["secret_refs"])
      ]
    : CONFIG_KEYS;
  const targetSegments = value?.target_path?.split("/");
  if (!exactData(value, keys) ||
      value.schema_version !== "1.0.0" ||
      ![MEMORY_DRIVER, STDIO_EFFECT_DRIVER].includes(value.driver) ||
      (stdio &&
        !DIGEST.test(value.backend_source_digest ?? "")) ||
      (value.approval_mode !== undefined &&
        (!stdio || value.approval_mode !== "cli")) ||
      (!stdio && secretRefs !== undefined) ||
      !bounded(value.state_directory, 1024) ||
      !bounded(value.skill_root, 1024) ||
      !DIGEST.test(value.skill_source_digest ?? "") ||
      !IDENTIFIER.test(value.transaction_id ?? "") ||
      !bounded(value.principal_id, 128) ||
      !bounded(value.client_id, 128) ||
      !bounded(value.target_path, 512) ||
      value.target_path.includes("\\") ||
      targetSegments.some((part) =>
        part === "" || part === "." || part === "..") ||
      !bounded(value.resource_scope, 2048)) {
    throw new TypeError("invalid Skill MCP configuration");
  }
  return deepFreeze({
    ...value,
    ...(secretRefs === undefined ? {} : { secret_refs: secretRefs }),
    state_directory: resolve(value.state_directory),
    skill_root: resolve(value.skill_root)
  });
}

export function loadSkillMcpConfigBundle(file) {
  try {
    const loaded = loadLayeredConfiguration(file);
    return deepFreeze({
      config: normalizeSkillMcpConfig(loaded.value),
      layers: loaded.files
    });
  } catch {
    throw new TypeError("invalid Skill MCP configuration");
  }
}

export function loadSkillMcpConfig(file) {
  return loadSkillMcpConfigBundle(file).config;
}

function rpcCall(rpc, id, method, params) {
  const response = SkillRpc.prototype.dispatch.call(rpc, {
    jsonrpc: "2.0", id, method, params
  });
  if (response.error) {
    throw new Error(response.error.data?.effectgate_code ?? response.error.code);
  }
  return response.result;
}

async function operatorRequest(config, rpc, request) {
  const keys = {
    "approval.inspect": ["schema_version", "method", "operation_id"],
    "approval.approve": [
      "schema_version", "method", "operation_id", "approver_id",
      "intent_digest"
    ],
    "approval.deny": ["schema_version", "method", "operation_id"],
    "operation.reconcile": ["schema_version", "method", "operation_id"]
  }[request?.method];
  if (!keys || !exactData(request, keys) ||
      request.schema_version !== "1.0.0" ||
      !IDENTIFIER.test(request.operation_id ?? "") ||
      (request.method === "approval.approve" &&
        (!IDENTIFIER.test(request.approver_id ?? "") ||
          !DIGEST.test(request.intent_digest ?? "")))) {
    throw new TypeError("invalid operator request");
  }
  if (request.method === "operation.reconcile") {
    return rpc.reconcileEffect(request.operation_id);
  }
  if (request.method === "approval.deny") {
    const denied = decideConfiguredApproval(
      config, request.operation_id, { decision: "deny" }
    );
    rpc.forgetApprovalReview(request.operation_id);
    return denied;
  }
  const review = rpc.approvalReview(request.operation_id);
  if (request.method === "approval.inspect") {
    return {
      ...inspectConfiguredApproval(config, request.operation_id),
      exact_arguments: review.exact_arguments
    };
  }
  if (review.intent_digest !== request.intent_digest) {
    const error = new Error("approval review changed");
    error.code = "EG_APPROVAL_INTENT_CHANGED";
    throw error;
  }
  const approved = decideConfiguredApproval(
    config,
    request.operation_id,
    {
      decision: "approve",
      approverId: request.approver_id
    }
  );
  rpc.forgetApprovalReview(request.operation_id);
  return approved;
}

export async function createConfiguredSkillMcp(configFile) {
  const config = loadSkillMcpConfigBundle(configFile).config;
  const secretEnvironment = resolveEnvironmentSecretRefs(
    config.secret_refs
  );
  mkdirSync(config.state_directory, { recursive: true, mode: 0o700 });
  const source = importSkillSource({
    root: config.skill_root,
    paths: SKILL_SOURCE_PATHS,
    expectedDigest: config.skill_source_digest
  });
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
      modify: {
        instruction_refs: ["phases/modify.md"],
        allowed_tools: ["filesystem.apply_patch"],
        allowed_effect_classes: ["mutate_reversible"]
      }
    },
    declaredTools: ["filesystem.apply_patch"],
    declaredEffectClasses: ["mutate_reversible"]
  });
  const skill = {
    source,
    passport,
    capabilities: {
      "filesystem.apply_patch": {
        revision: "patch-v1",
        effect_class: "mutate_reversible"
      }
    }
  };
  const store = new SkillEventStore({
    file: join(config.state_directory, "skill-events.db")
  });
  const journal = new EffectOperationJournal({
    file: join(config.state_directory, "effect-operations.db")
  });
  const approvals = config.approval_mode === "cli"
    ? new ApprovalLeaseStore({
        file: join(config.state_directory, "effect-operations.db")
      })
    : undefined;
  let backend;
  let operatorServer;
  try {
    const setup = new SkillRpc({
      skills: [skill],
      eventStore: store,
      effectJournal: journal,
      approvalStore: approvals
    });
    if (!store.load(config.transaction_id)) {
      rpcCall(setup, 1, "skills/transaction/start", {
        transaction_id: config.transaction_id,
        skill_id: "document-editor",
        initial_phase: "modify"
      });
    }
    const transaction = rpcCall(setup, 2, "skills/transaction/get", {
      transaction_id: config.transaction_id
    });
    if (!["awaiting_capsule", "active"].includes(transaction.status)) {
      return {
        mcp: new SkillMcp(setup),
        close() {
          approvals?.close();
          journal.close();
          store.close();
        }
      };
    }
    const persisted = store.load(config.transaction_id);
    const lastEvent = persisted.events.at(-1);
    const recoveryCapsuleDigest = transaction.active_capsule_digest ??
      (lastEvent?.kind === "capsule_activated"
        ? lastEvent.payload.capsule_digest
        : rpcCall(setup, 3, "skills/capsule/get", {
          transaction_id: config.transaction_id
        }).capsule_digest);
    const policyFor = (capsuleDigest) => compilePolicy({
      policyId: "configured-reviewed-patch",
      rules: [{
        id: "allow-reviewed-patch",
        decision: config.approval_mode === "cli" ? "ask" : "allow",
        match: {
          skill_id: "document-editor",
          skill_digest: source.source_digest,
          phase: "modify",
          phase_revision: 1,
          capsule_digest: capsuleDigest,
          capability_id: "filesystem.apply_patch",
          capability_revision: "patch-v1",
          effect_class: "mutate_reversible"
        }
      }]
    });
    const adapter = compileIdempotencyAdapter({
      schema_version: "1.0.0",
      capability_id: "filesystem.apply_patch",
      capability_revision: "patch-v1",
      key_placement: { target: "headers", name: "Idempotency-Key" },
      lookup: {
        capability_id: "filesystem.patch.lookup",
        capability_revision: "lookup-v1",
        key_argument: "idempotency_key"
      },
      qualified_scenarios: [
        "same_key_same_intent", "same_key_different_intent",
        "concurrent_duplicate_calls", "server_restart",
        "response_loss_after_commit"
      ],
      qualification_evidence_digest: digest(
        `${config.driver}:${config.backend_source_digest ?? ""}:idempotency`
      )
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
          path: "/status", equals: { literal: "not_found" }
        }],
        ambiguous: [{
          path: "/status", equals: { literal: "ambiguous" }
        }]
      },
      limits: {
        max_attempts: 3,
        per_attempt_timeout_ms:
          config.driver === STDIO_EFFECT_DRIVER ? 2000 : 50,
        total_timeout_ms: 300_000,
        max_result_bytes: 4096,
        initial_backoff_ms: 0,
        max_backoff_ms: 0,
        observation_window_ms: 0
      },
      evidence: {
        trust_level: "qualified_probe",
        redaction: "digest_only"
      },
      qualification_evidence_digest: digest(
        `${config.driver}:${config.backend_source_digest ?? ""}:probe`
      )
    });
    if (config.driver === STDIO_EFFECT_DRIVER) {
      backend = await createReviewedStdioEffectBackend({
        stateFile: join(
          config.state_directory,
          "stdio-effect-backend.db"
        ),
        targetPath: config.target_path,
        cwd: config.skill_root,
        expectedSourceDigest: config.backend_source_digest,
        secretEnvironment
      });
    } else {
      const memory = new Map();
      backend = {
        async apply({ path, content, idempotencyKey }) {
          memory.set(idempotencyKey, { path, content });
        },
        async lookup(idempotencyKey) {
          return memory.has(idempotencyKey) ? "found" : "not_found";
        },
        close() {}
      };
    }
    const command = {
      policy: policyFor(recoveryCapsuleDigest),
      adapter,
      descriptor,
      principalId: config.principal_id,
      clientId: config.client_id,
      effectClass: "mutate_reversible",
      tool: {
        name: TOOL_NAME,
        title: "Apply Verified Fixture Patch",
        description:
          "Applies one reviewed fixture patch and verifies it.",
        inputSchema: {
          type: "object",
          additionalProperties: false,
          required: ["path", "content"],
          properties: {
            path: { const: config.target_path },
            content: { type: "string", maxLength: 65536 }
          }
        }
      },
      validate: (argumentsValue, scope) =>
        exactData(argumentsValue, ["path", "content"]) &&
        argumentsValue.path === config.target_path &&
        typeof argumentsValue.content === "string" &&
        Buffer.byteLength(argumentsValue.content, "utf8") <= 65536 &&
        exactData(scope, ["kind", "value"]) &&
        scope.kind === "exact" &&
        scope.value === config.resource_scope,
      invoke: async (request) => {
        await backend.apply({
          path: request.arguments.path,
          content: request.arguments.content,
          idempotencyKey: request.headers["Idempotency-Key"]
        });
      },
      verify: async ({ arguments: lookup }) => {
        const status = await backend.lookup(lookup.idempotency_key);
        return {
          data: { status },
          evidence_ref:
            `${config.driver === STDIO_EFFECT_DRIVER ? "stdio" : "memory"}` +
            `://${config.target_path}`,
          evidence_digest: digest(
            `${config.driver}:${config.backend_source_digest ?? ""}:` +
            `evidence:${status}`
          )
        };
      }
    };
    const rpc = new SkillRpc({
      skills: [skill],
      eventStore: store,
      effectJournal: journal,
      approvalStore: approvals,
      effectCommands: [command]
    });
    await SkillRpc.prototype.recoverEffects.call(rpc);
    const current = rpcCall(rpc, 4, "skills/transaction/get", {
      transaction_id: config.transaction_id
    });
    let published;
    let publishedRpc;
    if (["awaiting_capsule", "active"].includes(current.status)) {
      const capsule = rpcCall(rpc, 5, "skills/capsule/get", {
        transaction_id: config.transaction_id
      });
      publishedRpc = capsule.capsule_digest === recoveryCapsuleDigest
        ? rpc
        : new SkillRpc({
          skills: [skill],
          eventStore: store,
          effectJournal: journal,
          approvalStore: approvals,
          effectCommands: [{
            ...command,
            policy: policyFor(capsule.capsule_digest)
          }]
        });
      published = new SkillMcp(publishedRpc, {
        bindings: {
          [TOOL_NAME]: {
            transaction_id: config.transaction_id,
            capsule_digest: capsule.capsule_digest
          }
        }
      });
    } else {
      publishedRpc = new SkillRpc({
        skills: [skill],
        eventStore: store,
        effectJournal: journal,
        approvalStore: approvals
      });
      published = new SkillMcp(publishedRpc);
    }
    if (config.approval_mode === "cli") {
      operatorServer = await createOperatorRpcServer({
        stateDirectory: config.state_directory,
        dispatch: (request) => operatorRequest(config, publishedRpc, request)
      });
    }
    return {
      mcp: published,
      async close() {
        await operatorServer?.close();
        await backend?.close();
        approvals?.close();
        journal.close();
        store.close();
      }
    };
  } catch (error) {
    await operatorServer?.close();
    await backend?.close();
    approvals?.close();
    journal.close();
    store.close();
    throw error;
  }
}
