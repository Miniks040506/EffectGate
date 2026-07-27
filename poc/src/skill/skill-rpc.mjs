import { compileInstructionCapsule } from "./capsule-compiler.mjs";
import { SkillTransaction } from "./phase-transaction.mjs";
import { SkillSourceError } from "./source-import.mjs";
import { skillReferencePath } from "./skill-graph.mjs";

const CAPSULE_TTL_MS = 5 * 60 * 1000;
const METHODS = new Set([
  "skills/list",
  "skills/passport/get",
  "skills/transaction/start",
  "skills/transaction/get",
  "skills/capsule/get",
  "skills/dependency/get",
  "skills/tool/admit",
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

export class SkillRpc {
  #eventStore;
  #now;
  #skills;
  #transactions = new Map();

  constructor({ skills, eventStore, now = Date.now } = {}) {
    if (!Array.isArray(skills) || skills.length < 1 ||
        !eventStore || typeof eventStore.load !== "function" ||
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
    this.#eventStore = eventStore;
    this.#now = now;
  }

  dispatch(request) {
    const id = request?.id;
    if (!request || request.jsonrpc !== "2.0" ||
        !(Number.isSafeInteger(id) || typeof id === "string") ||
        typeof request.method !== "string" ||
        !request.params || typeof request.params !== "object" ||
        Array.isArray(request.params)) {
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
      if (error instanceof SkillSourceError) {
        return rpcError(id, -32010, error.message, {
          effectgate_code: error.code
        });
      }
      return rpcError(id, -32603, "The Skill RPC operation failed.");
    }
  }

  #call(method, params) {
    switch (method) {
      case "skills/list":
        return {
          skills: [...this.#skills.values()]
            .map(({ passport }) => ({
              id: passport.skill.id,
              version: passport.skill.version,
              trust_tier: passport.skill.trust_tier,
              source_digest: passport.skill.source_digest,
              passport_digest: passport.passport_digest
            }))
            .sort((left, right) => left.id < right.id ? -1 : 1)
        };
      case "skills/passport/get":
        return this.#skill(params.skill_id).passport;
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
      case "skills/capsule/get":
        return this.#capsule(this.#transaction(params.transaction_id));
      case "skills/dependency/get":
        return this.#dependency(
          this.#transaction(params.transaction_id),
          params.source_ref
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
        return receipt;
      }
      case "skills/receipts/list":
        return {
          receipts: this.#transaction(params.transaction_id)
            .transaction.receipts()
        };
    }
  }

  #skill(id) {
    const skill = this.#skills.get(id);
    if (!skill) failure("EG_SKILL_SOURCE_INVALID", "skill is not registered");
    return skill;
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
}
