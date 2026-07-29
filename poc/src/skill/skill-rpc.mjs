import { BYTE_PROXY_COUNTER } from "../budget/token-counter.mjs";
import {
  deriveIdempotencyBinding,
  verifyIdempotencyAdapter
} from "../policy/idempotency-adapter.mjs";
import { EffectOperationJournal } from "../policy/operation-journal.mjs";
import {
  completePhaseEffectOperation,
  dispatchPhaseEffectOperation,
  planPhaseEffectOperation
} from "../policy/phase-effect-admission.mjs";
import {
  verifyVerificationProbe
} from "../policy/verification-probe.mjs";
import { compileInstructionCapsule } from "./capsule-compiler.mjs";
import { deepFreeze } from "./passport-compiler.mjs";
import { SkillTransaction } from "./phase-transaction.mjs";
import { SkillSourceError } from "./source-import.mjs";
import { skillReferencePath } from "./skill-graph.mjs";

const CAPSULE_TTL_MS = 5 * 60 * 1000;
const EFFECT_TTL_MS = 5 * 60 * 1000;
const DISPATCH_TTL_MS = 60 * 1000;
const EFFECT_CLASSES = new Set([
  "observe", "disclose", "mutate_reversible", "mutate_irreversible",
  "destructive", "external_commit", "credential_use", "code_execution"
]);
const EXTERNAL_EFFECTS = new Set([
  "disclose", "external_commit", "credential_use", "code_execution"
]);
const ASYNC_METHODS = new Set(["skills/effect/execute"]);
const METHODS = new Set([
  "skills/list",
  "skills/passport/get",
  "skills/transaction/start",
  "skills/transaction/get",
  "skills/capsule/get",
  "skills/dependency/get",
  "skills/tool/admit",
  "skills/effect/operation/get",
  "skills/effect/receipt/get",
  "skills/phase/report",
  "skills/receipts/list"
]);

function failure(code, message) {
  throw new SkillSourceError(code, message);
}

function rpcError(id, code, message, data) {
  return {
    jsonrpc: "2.0",
    id: Number.isSafeInteger(id) || typeof id === "string" ? id : null,
    error: { code, message, ...(data ? { data } : {}) }
  };
}

function validRequest(request) {
  const id = request?.id;
  return request && request.jsonrpc === "2.0" &&
    (Number.isSafeInteger(id) || typeof id === "string") &&
    typeof request.method === "string" &&
    request.params && typeof request.params === "object" &&
    !Array.isArray(request.params);
}

function caughtError(id, error) {
  if (error instanceof SkillSourceError) {
    return rpcError(id, -32010, error.message, {
      effectgate_code: error.code
    });
  }
  if (/^EG_[A-Z0-9_]+$/u.test(error?.code ?? "")) {
    return rpcError(id, -32010, "The effect operation was denied.", {
      effectgate_code: error.code,
      ...(error.safeReasonCode
        ? { safe_reason_code: error.safeReasonCode }
        : {})
    });
  }
  return rpcError(id, -32603, "The Skill RPC operation failed.");
}

function commandKey(capabilityId, capabilityRevision) {
  return `${capabilityId}\0${capabilityRevision}`;
}

function runtimeId(value) {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= 128 && Buffer.byteLength(value, "utf8") <= 512 &&
    !value.includes("\0") && value === value.normalize("NFC");
}

function effectTool(command) {
  const tool = command.tool;
  let inputSchema;
  try {
    inputSchema = structuredClone(tool?.inputSchema);
  } catch {
    throw new TypeError("invalid effect command tool");
  }
  const schemaBytes = Buffer.byteLength(JSON.stringify(inputSchema));
  if (!tool || typeof tool !== "object" || Array.isArray(tool) ||
      Reflect.ownKeys(tool).length !== 4 ||
      !["name", "title", "description", "inputSchema"].every(
        (key) => Object.hasOwn(tool, key)
      ) ||
      !/^[A-Za-z0-9_.-]{1,128}$/u.test(tool.name ?? "") ||
      !runtimeId(tool.title) ||
      typeof tool.description !== "string" ||
      Buffer.byteLength(tool.description, "utf8") > 2048 ||
      !inputSchema || typeof inputSchema !== "object" ||
      Array.isArray(inputSchema) || inputSchema.type !== "object" ||
      inputSchema.additionalProperties !== false ||
      schemaBytes > 32 * 1024) {
    throw new TypeError("invalid effect command tool");
  }
  const identifier = {
    type: "string",
    minLength: 1,
    maxLength: 128,
    pattern: "^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$"
  };
  const digest = {
    type: "string",
    pattern: "^sha256:[a-f0-9]{64}$"
  };
  return deepFreeze({
    contract: {
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: [
          "transaction_id", "operation_id", "receipt_id", "capsule_digest",
          "arguments", "resource_scope", "disclosure_digest"
        ],
        properties: {
          transaction_id: identifier,
          operation_id: identifier,
          receipt_id: identifier,
          capsule_digest: digest,
          arguments: inputSchema,
          resource_scope: {
            type: "object",
            additionalProperties: false,
            required: ["kind", "value"],
            properties: {
              kind: { type: "string", enum: ["exact", "prefix"] },
              value: { type: "string", minLength: 1, maxLength: 2048 }
            }
          },
          disclosure_digest: digest
        }
      },
      outputSchema: {
        type: "object",
        oneOf: [
          { required: ["schema_version", "status", "operation_id"] },
          { required: ["effectgate_code"] }
        ],
        properties: {
          schema_version: { const: "1.0.0" },
          status: {
            type: "string",
            enum: [
              "completed", "verified_not_committed", "manual_resolution"
            ]
          },
          operation_id: identifier,
          effect_receipt: { type: "object" },
          phase_receipt: { type: "object" },
          effectgate_code: {
            type: "string",
            pattern: "^EG_[A-Z0-9_]+$"
          },
          safe_reason_code: { type: "string", maxLength: 128 }
        }
      },
      annotations: {
        readOnlyHint: command.effectClass === "observe",
        destructiveHint: !["observe", "mutate_reversible"].includes(
          command.effectClass
        ),
        idempotentHint: true,
        openWorldHint: EXTERNAL_EFFECTS.has(command.effectClass)
      }
    },
    capability_id: command.adapter.capability_id,
    capability_revision: command.adapter.capability_revision,
    effect_class: command.effectClass
  });
}

function effectCommandRegistry(commands = []) {
  if (!Array.isArray(commands)) {
    throw new TypeError("invalid effect command registry");
  }
  const registry = new Map();
  const toolNames = new Set();
  for (const command of commands) {
    const keys = [
      "policy", "adapter", "descriptor", "principalId", "clientId",
      "effectClass", "tool", "validate", "invoke", "verify"
    ];
    if (!command || typeof command !== "object" || Array.isArray(command) ||
        Reflect.ownKeys(command).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(command, key)) ||
        !runtimeId(command.principalId) ||
        !runtimeId(command.clientId) ||
        !EFFECT_CLASSES.has(command.effectClass) ||
        typeof command.validate !== "function" ||
        typeof command.invoke !== "function" ||
        typeof command.verify !== "function") {
      throw new TypeError("invalid effect command registry");
    }
    verifyIdempotencyAdapter(command.adapter);
    verifyVerificationProbe(command.descriptor);
    const key = commandKey(
      command.adapter.capability_id,
      command.adapter.capability_revision
    );
    const publication = effectTool(command);
    if (registry.has(key) || toolNames.has(publication.contract.name) ||
        command.descriptor.capability_id !==
          command.adapter.capability_id ||
        command.descriptor.capability_revision !==
          command.adapter.capability_revision) {
      throw new TypeError("invalid effect command registry");
    }
    toolNames.add(publication.contract.name);
    registry.set(key, Object.freeze({ ...command, publication }));
  }
  return registry;
}

export class SkillRpc {
  #effectCommands;
  #effectJournal;
  #eventStore;
  #ledger;
  #now;
  #skills;
  #transactions = new Map();

  constructor({
    skills,
    eventStore,
    effectJournal,
    effectCommands,
    tokenLedger,
    now = Date.now
  } = {}) {
    if (!Array.isArray(skills) || skills.length < 1 ||
        !eventStore || typeof eventStore.load !== "function" ||
        (effectJournal !== undefined &&
          !(effectJournal instanceof EffectOperationJournal)) ||
        (tokenLedger !== undefined &&
          typeof tokenLedger?.append !== "function") ||
        typeof now !== "function") {
      throw new TypeError("invalid Skill RPC configuration");
    }
    this.#skills = new Map();
    for (const entry of skills) {
      const id = entry?.passport?.skill?.id;
      if (typeof id !== "string" || this.#skills.has(id) ||
          entry.source?.source_digest !==
            entry.passport?.skill?.source_digest ||
          !entry.capabilities || typeof entry.capabilities !== "object") {
        throw new TypeError("invalid Skill RPC registry");
      }
      this.#skills.set(id, entry);
    }
    this.#effectJournal = effectJournal;
    this.#effectCommands = effectCommandRegistry(effectCommands);
    if (this.#effectCommands.size > 0 && !this.#effectJournal) {
      throw new TypeError("invalid Skill RPC configuration");
    }
    this.#eventStore = eventStore;
    this.#ledger = tokenLedger;
    this.#now = now;
  }

  dispatch(request) {
    const id = request?.id;
    if (!validRequest(request)) {
      return rpcError(id, -32600, "The JSON-RPC request is invalid.");
    }
    if (!METHODS.has(request.method)) {
      return rpcError(id, -32601, "The requested method is unavailable.");
    }
    try {
      return {
        jsonrpc: "2.0",
        id,
        result: this.#call(request.method, request.params)
      };
    } catch (error) {
      return caughtError(id, error);
    }
  }

  async dispatchAsync(request) {
    const id = request?.id;
    if (!validRequest(request)) {
      return rpcError(id, -32600, "The JSON-RPC request is invalid.");
    }
    if (!ASYNC_METHODS.has(request.method)) return this.dispatch(request);
    try {
      return {
        jsonrpc: "2.0",
        id,
        result: await this.#executeEffect(request.params)
      };
    } catch (error) {
      return caughtError(id, error);
    }
  }

  async recoverEffects() {
    const journal = this.#effects();
    const startup = EffectOperationJournal.prototype.recover.call(journal);
    const outcomes = [];
    for (const candidate of
      EffectOperationJournal.prototype.recoveryCandidates.call(journal)) {
      let operation = candidate.operation;
      if (operation.state === "manual_resolution") {
        failure(
          "EG_OPERATION_RETRY_DENIED",
          "effect recovery requires manual resolution"
        );
      }
      if (["uncertain", "reconciling"].includes(operation.state)) {
        const command = this.#effectCommands.get(commandKey(
          operation.capability_id,
          operation.capability_revision
        ));
        if (!command) {
          failure(
            "EG_EFFECT_COMMAND_UNAVAILABLE",
            "effect recovery command is unavailable"
          );
        }
        const active = this.#transaction(operation.transaction_id);
        const phase = active.transaction.snapshot();
        if (!["active", "awaiting_capsule"].includes(phase.status) ||
            phase.current_phase !== operation.phase ||
            phase.next_phase_revision !== operation.phase_revision ||
            (phase.status === "active" &&
              phase.active_capsule_digest !== operation.capsule_digest)) {
          failure(
            "EG_PHASE_TRANSITION_DENIED",
            "effect recovery phase is unavailable"
          );
        }
        const binding = deriveIdempotencyBinding({
          adapter: command.adapter,
          operation
        });
        const persisted = operation.idempotency;
        const fields = [
          "adapter_digest", "key_hash", "key_target", "key_name",
          "lookup_capability_id", "lookup_capability_revision"
        ];
        if (!persisted ||
            fields.some((field) => persisted[field] !== binding[field])) {
          failure(
            "EG_IDEMPOTENCY_BINDING_MISMATCH",
            "effect recovery binding is invalid"
          );
        }
        operation = await EffectOperationJournal.prototype.reconcile.call(
          journal,
          {
            operationId: operation.operation_id,
            descriptor: command.descriptor,
            idempotency: { adapter: command.adapter, binding },
            invoke: command.verify
          }
        );
        if (operation.state === "manual_resolution") {
          failure(
            "EG_OPERATION_RETRY_DENIED",
            "effect recovery requires manual resolution"
          );
        }
      }
      let receiptId = candidate.receipt_id;
      if (operation.state === "verified_committed") {
        const active = this.#transaction(operation.transaction_id);
        const phase = active.transaction.snapshot();
        const current = ["active", "awaiting_capsule"].includes(
          phase.status
        ) &&
          phase.current_phase === operation.phase &&
          phase.next_phase_revision === operation.phase_revision &&
          (phase.status === "awaiting_capsule" ||
            phase.active_capsule_digest === operation.capsule_digest);
        if (current) {
          receiptId ??=
            `recovery-${operation.intent_digest.slice("sha256:".length)}`;
          completePhaseEffectOperation({
            operationId: operation.operation_id,
            receiptId,
            journal,
            transaction: active.transaction,
            recovering: true
          });
          active.capsule = undefined;
        }
      }
      outcomes.push({
        operation_id: operation.operation_id,
        state: operation.state,
        receipt_id: receiptId
      });
    }
    return deepFreeze({
      schema_version: "1.0.0",
      startup,
      outcomes
    });
  }

  effectTools() {
    return [...this.#effectCommands.values()]
      .map(({ publication }) => publication)
      .sort((left, right) =>
        left.contract.name < right.contract.name ? -1 : 1);
  }

  #call(method, params) {
    switch (method) {
      case "skills/list":
        return this.#record({
          skills: [...this.#skills.values()]
            .map(({ passport }) => ({
              id: passport.skill.id,
              version: passport.skill.version,
              trust_tier: passport.skill.trust_tier,
              source_digest: passport.skill.source_digest,
              passport_digest: passport.passport_digest
            }))
            .sort((left, right) => left.id < right.id ? -1 : 1)
        }, "skill_catalog", "to_host", "skill_catalog_tokens_emitted");
      case "skills/passport/get":
        return this.#record(
          this.#skill(params.skill_id).passport,
          "skill_catalog",
          "to_host",
          "skill_catalog_tokens_emitted"
        );
      case "skills/transaction/start": {
        const skill = this.#skill(params.skill_id);
        const transaction = new SkillTransaction({
          transactionId: params.transaction_id,
          passport: skill.passport,
          initialPhase: params.initial_phase,
          eventStore: this.#eventStore,
          now: this.#now
        });
        this.#transactions.set(params.transaction_id, {
          skill, transaction, capsule: undefined
        });
        return transaction.snapshot();
      }
      case "skills/transaction/get":
        return this.#transaction(params.transaction_id).transaction.snapshot();
      case "skills/capsule/get": {
        const active = this.#transaction(params.transaction_id);
        const capsule = this.#capsule(active);
        this.#recordAvoidedInstructions(active, capsule);
        return this.#record(
          capsule,
          "skill_instruction",
          "to_host",
          "skill_instruction_tokens_emitted"
        );
      }
      case "skills/dependency/get":
        return this.#record(
          this.#dependency(
            this.#transaction(params.transaction_id),
            params.source_ref
          ),
          "instruction_dependency",
          "to_host",
          "instruction_dependency_fetch_tokens"
        );
      case "skills/tool/admit": {
        const active = this.#transaction(params.transaction_id);
        return active.transaction.admitTool({
          capsule: active.capsule,
          capsuleDigest: params.capsule_digest,
          capabilityId: params.capability_id,
          capabilityRevision: params.capability_revision,
          effectClass: params.effect_class
        });
      }
      case "skills/effect/operation/get":
        return this.#record(
          this.#effectOperation(
            this.#transaction(params.transaction_id),
            params.operation_id
          ),
          "verification",
          "to_host",
          "verification_overhead_tokens"
        );
      case "skills/effect/receipt/get":
        return this.#record(
          this.#effectReceipt(
            this.#transaction(params.transaction_id),
            params.receipt_id
          ),
          "verification",
          "to_host",
          "verification_overhead_tokens"
        );
      case "skills/phase/report": {
        const active = this.#transaction(params.transaction_id);
        const receipt = active.transaction.reportPhaseOutcome({
          capsuleDigest: params.capsule_digest,
          status: params.status,
          inputArtifactDigests: params.input_artifact_digests,
          findingRefs: params.finding_refs,
          effectReceiptRefs: params.effect_receipt_refs
        });
        active.capsule = undefined;
        return this.#record(
          receipt,
          "phase_receipt",
          "to_host",
          "phase_receipt_tokens_emitted"
        );
      }
      case "skills/receipts/list":
        return this.#record({
          receipts: this.#transaction(params.transaction_id)
            .transaction.receipts()
        }, "phase_receipt", "to_host", "phase_receipt_tokens_emitted");
    }
  }

  #skill(id) {
    const skill = this.#skills.get(id);
    if (!skill) failure("EG_SKILL_SOURCE_INVALID", "skill is not registered");
    return skill;
  }

  async #executeEffect(params) {
    const keys = [
      "transaction_id", "operation_id", "receipt_id", "capsule_digest",
      "capability_id", "capability_revision", "effect_class", "arguments",
      "resource_scope", "disclosure_digest"
    ];
    if (Reflect.ownKeys(params).length !== keys.length ||
        keys.some((key) => !Object.hasOwn(params, key))) {
      failure("EG_EFFECT_COMMAND_INVALID", "effect command is invalid");
    }
    const active = this.#transaction(params.transaction_id);
    const command = this.#effectCommands.get(commandKey(
      params.capability_id, params.capability_revision
    ));
    if (!command) {
      failure(
        "EG_EFFECT_COMMAND_UNAVAILABLE",
        "effect command is unavailable"
      );
    }
    if (params.effect_class !== command.effectClass) {
      failure("EG_EFFECT_COMMAND_INVALID", "effect command is invalid");
    }
    let validArguments = false;
    try {
      validArguments = command.validate(
        params.arguments,
        params.resource_scope
      ) === true;
    } catch {
      validArguments = false;
    }
    if (!validArguments) {
      failure("EG_EFFECT_COMMAND_INVALID", "effect command is invalid");
    }
    const current = this.#now();
    if (!Number.isFinite(current)) {
      failure("EG_PHASE_TRANSITION_DENIED", "Skill RPC clock is invalid");
    }
    const effect = {
      transaction: active.transaction,
      capsule: active.capsule,
      capsuleDigest: params.capsule_digest,
      capabilityId: params.capability_id,
      capabilityRevision: params.capability_revision,
      effectClass: params.effect_class,
      policy: command.policy,
      principalId: command.principalId,
      clientId: command.clientId,
      sessionId: params.transaction_id,
      arguments: params.arguments,
      resourceScope: params.resource_scope,
      disclosureDigest: params.disclosure_digest,
      expiresAt: new Date(current + EFFECT_TTL_MS).toISOString(),
      now: this.#now
    };
    planPhaseEffectOperation({
      operationId: params.operation_id,
      journal: this.#effects(),
      effect
    });
    const dispatched = await dispatchPhaseEffectOperation({
      operationId: params.operation_id,
      journal: this.#effects(),
      effect,
      adapter: command.adapter,
      request: { arguments: params.arguments, headers: {} },
      deadlineAt: new Date(current + DISPATCH_TTL_MS).toISOString(),
      invoke: command.invoke
    });
    if (dispatched.response_received) {
      EffectOperationJournal.prototype.markUncertain.call(this.#effects(), {
        operationId: params.operation_id,
        evidenceRef: dispatched.idempotency.dispatch_digest,
        reason: "post_dispatch_verification_required"
      });
    }
    const operation = await EffectOperationJournal.prototype.reconcile.call(
      this.#effects(),
      {
        operationId: params.operation_id,
        descriptor: command.descriptor,
        idempotency: dispatched.idempotency,
        invoke: command.verify
      }
    );
    let result;
    if (operation.state === "verified_committed") {
      result = completePhaseEffectOperation({
        operationId: params.operation_id,
        receiptId: params.receipt_id,
        journal: this.#effects(),
        transaction: active.transaction
      });
      active.capsule = undefined;
    } else {
      result = {
        schema_version: "1.0.0",
        status: operation.state,
        operation_id: params.operation_id
      };
    }
    return this.#record(
      result,
      "verification",
      "to_host",
      "verification_overhead_tokens"
    );
  }

  #effects() {
    if (!this.#effectJournal) {
      failure(
        "EG_VERIFIED_EFFECT_UNAVAILABLE",
        "verified effects are unavailable"
      );
    }
    return this.#effectJournal;
  }

  #effectOperation(active, operationId) {
    const operation = EffectOperationJournal.prototype.load.call(
      this.#effects(),
      operationId
    )?.operation;
    if (operation?.transaction_id !==
        active.transaction.snapshot().transaction_id) {
      failure("EG_OPERATION_NOT_FOUND", "effect operation does not exist");
    }
    return operation;
  }

  #effectReceipt(active, receiptId) {
    const receipt = EffectOperationJournal.prototype.loadReceipt.call(
      this.#effects(),
      receiptId
    );
    if (receipt?.transaction_id !==
        active.transaction.snapshot().transaction_id) {
      failure("EG_RECEIPT_NOT_FOUND", "Effect Receipt does not exist");
    }
    return receipt;
  }

  #transaction(id) {
    let active = this.#transactions.get(id);
    if (active) return active;
    const persisted = this.#eventStore.load(id);
    if (!persisted) {
      failure("EG_SKILL_SOURCE_INVALID", "transaction does not exist");
    }
    const skill = [...this.#skills.values()].find(({ passport }) =>
      passport.passport_digest === persisted.transaction.passport_digest);
    if (!skill) {
      failure("EG_SKILL_DIGEST_DRIFT", "transaction Passport is unavailable");
    }
    const transaction = SkillTransaction.recover({
      transactionId: id,
      passport: skill.passport,
      eventStore: this.#eventStore,
      now: this.#now
    });
    active = { skill, transaction, capsule: undefined };
    if (transaction.snapshot().status === "active") {
      const event = persisted.events.at(-1);
      active.capsule = this.#compile(active, event?.payload?.expires_at);
      if (active.capsule.capsule_digest !==
          transaction.snapshot().active_capsule_digest) {
        failure("EG_SKILL_DIGEST_DRIFT", "active Capsule cannot be recovered");
      }
    }
    this.#transactions.set(id, active);
    return active;
  }

  #compile(active, expiresAt) {
    const state = active.transaction.snapshot();
    return compileInstructionCapsule({
      passport: active.skill.passport,
      source: active.skill.source,
      phase: state.current_phase,
      capabilities: active.skill.capabilities,
      phaseRevision: state.next_phase_revision,
      maxTokens: 5000,
      maxBytes: 20000,
      expiresAt
    });
  }

  #capsule(active) {
    const state = active.transaction.snapshot();
    if (active.capsule?.capsule_digest === state.active_capsule_digest) {
      return active.capsule;
    }
    active.capsule = undefined;
    const current = this.#now();
    if (!Number.isFinite(current)) {
      failure("EG_PHASE_TRANSITION_DENIED", "Skill RPC clock is invalid");
    }
    const capsule = this.#compile(
      active,
      new Date(current + CAPSULE_TTL_MS).toISOString()
    );
    active.transaction.activateCapsule(capsule);
    active.capsule = capsule;
    return capsule;
  }

  #dependency(active, sourceRef) {
    const admitted = active.capsule &&
      [...active.capsule.invariants, ...active.capsule.instructions]
        .some((item) => item.source_ref === sourceRef);
    if (!admitted) {
      failure("EG_SKILL_DEPENDENCY_MISSING", "dependency is not in the Capsule");
    }
    const path = skillReferencePath(sourceRef);
    const file = active.skill.source.files.find((item) => item.path === path);
    return { source_ref: sourceRef, digest: file.digest, text: file.text };
  }

  #record(value, stage, direction, category, metadata = {}) {
    if (!this.#ledger) return value;
    const content = JSON.stringify(value);
    this.#ledger.append({
      stage,
      direction,
      tokenCount: BYTE_PROXY_COUNTER.measure({ content }),
      bytes: Buffer.byteLength(content),
      category,
      ...metadata
    });
    return value;
  }

  #recordAvoidedInstructions(active, capsule) {
    if (!this.#ledger) return;
    const included = new Set(
      [...capsule.invariants, ...capsule.instructions]
        .map(({ source_ref: reference }) => skillReferencePath(reference))
    );
    const content = active.skill.source.files
      .filter(({ path }) => !included.has(path))
      .map(({ text }) => text)
      .join("");
    this.#ledger.append({
      stage: "skill_instruction",
      direction: "counterfactual",
      tokenCount: BYTE_PROXY_COUNTER.measure({ content }),
      bytes: Buffer.byteLength(content),
      category: "skill_instruction_tokens_avoided",
      comparator: "full_skill_source",
      sourceDigest: active.skill.source.source_digest
    });
  }
}
