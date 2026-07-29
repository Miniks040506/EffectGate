import { instructionCapsuleDigest } from "./capsule-compiler.mjs";
import { deepFreeze, skillPassportDigest } from "./passport-compiler.mjs";
import { SkillSourceError } from "./source-import.mjs";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const STATUSES = new Set(["completed", "failed", "aborted"]);

function fail(code, message) {
  throw new SkillSourceError(code, message);
}

function boundedList(value, maximum, pattern, label) {
  if (!Array.isArray(value) || value.length > maximum ||
      new Set(value).size !== value.length ||
      value.some((item) => typeof item !== "string" ||
        item.length < 1 || item.length > 1024 ||
        (pattern && !pattern.test(item)))) {
    fail("EG_SKILL_SOURCE_INVALID", `${label} must be bounded and unique`);
  }
  return [...value];
}

function verifyPassport(passport) {
  if (!passport || typeof passport !== "object") {
    fail("EG_SKILL_SOURCE_INVALID", "transaction Passport is invalid");
  }
  const { passport_digest: claimed, ...body } = passport;
  if (!DIGEST_PATTERN.test(claimed ?? "") ||
      skillPassportDigest(body) !== claimed) {
    fail("EG_SKILL_DIGEST_DRIFT", "transaction Passport digest does not match");
  }
}

function verifyCapsule(capsule) {
  if (!capsule || typeof capsule !== "object") {
    fail("EG_PHASE_TRANSITION_DENIED", "Capsule is invalid");
  }
  const { capsule_digest: claimed, ...body } = capsule;
  if (!DIGEST_PATTERN.test(claimed ?? "") ||
      instructionCapsuleDigest(body) !== claimed) {
    fail("EG_SKILL_DIGEST_DRIFT", "Capsule digest does not match");
  }
}

export class SkillTransaction {
  #activeDigest; #activeExpiry; #eventStore; #expiredDigest; #id; #now;
  #passport; #phase;
  #receipts = [];
  #revision = 1;
  #status = "awaiting_capsule";

  constructor({ transactionId, passport, initialPhase, now = Date.now,
    eventStore } = {}) {
    verifyPassport(passport);
    if (typeof transactionId !== "string" ||
        transactionId.length < 1 || transactionId.length > 128) {
      fail("EG_SKILL_SOURCE_INVALID", "transaction ID is invalid");
    }
    if (!Object.hasOwn(passport.phases, initialPhase) ||
        typeof now !== "function") {
      fail("EG_PHASE_TRANSITION_DENIED", "initial phase is invalid");
    }
    this.#id = transactionId;
    this.#passport = deepFreeze(structuredClone(passport));
    this.#phase = initialPhase;
    this.#now = now;
    this.#eventStore = eventStore;
    if (eventStore) {
      eventStore.startTransaction({
        transactionId,
        passportDigest: passport.passport_digest,
        skillDigest: passport.skill.source_digest,
        initialPhase,
        createdAt: this.#timestamp()
      });
    }
  }

  static recover({ transactionId, passport, eventStore, now = Date.now } = {}) {
    if (!eventStore || typeof eventStore.load !== "function") {
      fail("EG_SKILL_SOURCE_INVALID", "event store is invalid");
    }
    const loaded = eventStore.load(transactionId);
    if (!loaded ||
        loaded.transaction.passport_digest !== passport?.passport_digest ||
        loaded.transaction.skill_digest !== passport?.skill?.source_digest) {
      fail("EG_SKILL_DIGEST_DRIFT", "persisted transaction binding is invalid");
    }
    const transaction = new SkillTransaction({
      transactionId,
      passport,
      initialPhase: loaded.transaction.initial_phase,
      now
    });
    transaction.#eventStore = eventStore;
    for (const event of loaded.events) transaction.#replay(event);
    if (transaction.#status === "active") {
      transaction.#expire(transaction.#now());
    }
    return transaction;
  }

  snapshot() {
    this.#expire(this.#now());
    return deepFreeze({
      transaction_id: this.#id,
      status: this.#status,
      current_phase: this.#phase,
      next_phase_revision: this.#revision,
      active_capsule_digest: this.#activeDigest ?? null,
      receipt_count: this.#receipts.length
    });
  }

  receipts() {
    return Object.freeze([...this.#receipts]);
  }

  admitTool({
    capsule,
    capsuleDigest,
    capabilityId,
    capabilityRevision,
    effectClass
  } = {}) {
    this.#expire(this.#now());
    if (this.#status !== "active" ||
        capsuleDigest !== this.#activeDigest ||
        capsule?.capsule_digest !== this.#activeDigest) {
      fail("EG_PHASE_TRANSITION_DENIED", "tool call has no active Capsule");
    }
    verifyCapsule(capsule);
    this.#verifyCapsuleBinding(capsule);
    const capability = capsule.allowed_tools.find(
      (tool) => tool.capability_id === capabilityId
    );
    if (!capability ||
        capability.capability_revision !== capabilityRevision) {
      fail("EG_PHASE_TOOL_NOT_ALLOWED", "capability is not admitted");
    }
    if (capability.effect_class !== effectClass) {
      fail("EG_PHASE_EFFECT_CLASS_NOT_ALLOWED", "effect class is not admitted");
    }
    return deepFreeze({
      schema_version: "1.0.0",
      transaction_id: this.#id,
      skill_id: this.#passport.skill.id,
      skill_digest: this.#passport.skill.source_digest,
      phase: this.#phase,
      phase_revision: this.#revision,
      capsule_digest: this.#activeDigest,
      capability_id: capabilityId,
      capability_revision: capabilityRevision,
      effect_class: effectClass
    });
  }

  activateCapsule(capsule) {
    if (this.#status !== "awaiting_capsule") {
      fail("EG_PHASE_TRANSITION_DENIED", "transaction is not awaiting a Capsule");
    }
    verifyCapsule(capsule);
    this.#verifyCapsuleBinding(capsule);
    const expiry = Date.parse(capsule.expires_at);
    const now = this.#now();
    if (!Number.isFinite(expiry) || !Number.isFinite(now) || expiry <= now) {
      fail("EG_PHASE_TRANSITION_DENIED", "Capsule has expired");
    }
    const included = new Set(capsule.invariants?.map((item) => item.id));
    if (this.#passport.invariants.some((item) => !included.has(item.id))) {
      fail("EG_CAPSULE_INVARIANT_MISSING", "pinned invariant is absent");
    }
    this.#eventStore?.append({
      transactionId: this.#id,
      kind: "capsule_activated",
      phase: this.#phase,
      phaseRevision: this.#revision,
      payload: {
        capsule_digest: capsule.capsule_digest,
        expires_at: capsule.expires_at
      },
      observedAt: new Date(now).toISOString()
    });
    this.#activeDigest = capsule.capsule_digest;
    this.#activeExpiry = expiry;
    this.#expiredDigest = undefined;
    this.#status = "active";
    return this.snapshot();
  }

  reportPhaseOutcome({
    capsuleDigest,
    status,
    inputArtifactDigests = [],
    findingRefs = [],
    effectReceiptRefs = []
  } = {}) {
    this.#expire(this.#now());
    if (this.#status !== "active" ||
        capsuleDigest !== this.#activeDigest ||
        !STATUSES.has(status)) {
      fail("EG_PHASE_TRANSITION_DENIED", "phase outcome is not admissible");
    }
    const inputs = boundedList(
      inputArtifactDigests,
      4096,
      DIGEST_PATTERN,
      "input artifact digests"
    );
    const findings = boundedList(findingRefs, 4096, null, "finding refs");
    const effects = boundedList(
      effectReceiptRefs,
      4096,
      null,
      "effect receipt refs"
    );
    const transition = this.#passport.phases[this.#phase].transition;
    const nextPhase = status === "completed"
      ? transition?.on_success ?? null
      : status === "failed"
        ? transition?.on_failure ?? null
        : null;
    const receipt = deepFreeze({
      schema_version: "1.0.0",
      skill_id: this.#passport.skill.id,
      skill_digest: this.#passport.skill.source_digest,
      phase: this.#phase,
      capsule_digest: this.#activeDigest,
      status,
      input_artifact_digests: inputs,
      finding_refs: findings,
      effect_receipt_refs: effects,
      next_phase: nextPhase
    });
    this.#eventStore?.append({
      transactionId: this.#id,
      kind: "phase_receipt",
      phase: this.#phase,
      phaseRevision: this.#revision,
      payload: receipt,
      observedAt: this.#timestamp()
    });
    this.#applyReceipt(receipt);
    return receipt;
  }

  recoverPhaseOutcome({ capsuleDigest, effectReceiptRefs = [] } = {}) {
    this.#expire(this.#now());
    if (this.#status === "active" &&
        capsuleDigest === this.#activeDigest) {
      return this.reportPhaseOutcome({
        capsuleDigest,
        status: "completed",
        effectReceiptRefs
      });
    }
    if (this.#status !== "awaiting_capsule" ||
        capsuleDigest !== this.#expiredDigest) {
      fail(
        "EG_PHASE_TRANSITION_DENIED",
        "expired Capsule is unavailable for effect recovery"
      );
    }
    const expiredDigest = this.#expiredDigest;
    this.#activeDigest = expiredDigest;
    this.#activeExpiry = Number.POSITIVE_INFINITY;
    this.#expiredDigest = undefined;
    this.#status = "active";
    try {
      return this.reportPhaseOutcome({
        capsuleDigest,
        status: "completed",
        effectReceiptRefs
      });
    } catch (error) {
      this.#activeDigest = undefined;
      this.#activeExpiry = undefined;
      this.#expiredDigest = expiredDigest;
      this.#status = "awaiting_capsule";
      throw error;
    }
  }

  #applyReceipt(receipt) {
    this.#receipts.push(receipt);
    this.#activeDigest = undefined;
    this.#activeExpiry = undefined;
    this.#expiredDigest = undefined;
    if (receipt.next_phase === null) {
      this.#phase = null;
      this.#status = receipt.status;
    } else {
      this.#phase = receipt.next_phase;
      this.#revision += 1;
      this.#status = "awaiting_capsule";
    }
  }

  #replay(event) {
    this.#expire(Date.parse(event.observed_at));
    if (event.phase !== this.#phase ||
        event.phase_revision !== this.#revision) {
      fail("EG_SKILL_DIGEST_DRIFT", "persisted phase sequence is invalid");
    }
    if (event.kind === "capsule_activated") {
      const expiry = Date.parse(event.payload?.expires_at);
      if (this.#status !== "awaiting_capsule" ||
          !DIGEST_PATTERN.test(event.payload?.capsule_digest ?? "") ||
          !Number.isFinite(expiry)) {
        fail("EG_SKILL_DIGEST_DRIFT", "persisted Capsule event is invalid");
      }
      this.#activeDigest = event.payload.capsule_digest;
      this.#activeExpiry = expiry;
      this.#expiredDigest = undefined;
      this.#status = "active";
      return;
    }
    const receipt = event.payload;
    const transition = this.#passport.phases[this.#phase].transition;
    const expectedNext = receipt?.status === "completed"
      ? transition?.on_success ?? null
      : receipt?.status === "failed"
        ? transition?.on_failure ?? null
        : null;
    const recoveredExpired = this.#status === "awaiting_capsule" &&
      receipt?.status === "completed" &&
      receipt?.capsule_digest === this.#expiredDigest &&
      Array.isArray(receipt?.effect_receipt_refs) &&
      receipt.effect_receipt_refs.length > 0;
    if (event.kind !== "phase_receipt" ||
        (this.#status !== "active" && !recoveredExpired) ||
        receipt?.schema_version !== "1.0.0" ||
        receipt.skill_id !== this.#passport.skill.id ||
        receipt.skill_digest !== this.#passport.skill.source_digest ||
        receipt.phase !== this.#phase ||
        receipt.capsule_digest !==
          (recoveredExpired ? this.#expiredDigest : this.#activeDigest) ||
        !STATUSES.has(receipt.status) ||
        receipt.next_phase !== expectedNext) {
      fail("EG_SKILL_DIGEST_DRIFT", "persisted Phase Receipt is invalid");
    }
    this.#applyReceipt(deepFreeze(structuredClone(receipt)));
  }

  #verifyCapsuleBinding(capsule) {
    if (capsule.phase !== this.#phase ||
        capsule.phase_revision !== this.#revision ||
        capsule.skill_id !== this.#passport.skill.id ||
        capsule.skill_version !== this.#passport.skill.version ||
        capsule.skill_digest !== this.#passport.skill.source_digest ||
        capsule.provenance?.passport_digest !==
          this.#passport.passport_digest) {
      fail("EG_SKILL_DIGEST_DRIFT", "Capsule is not bound to this phase");
    }
    const phase = this.#passport.phases[this.#phase];
    if (!Array.isArray(capsule.allowed_tools) ||
        new Set(capsule.allowed_tools.map((tool) => tool?.capability_id)).size !==
        capsule.allowed_tools.length ||
        capsule.allowed_tools.some((tool) =>
          typeof tool?.capability_revision !== "string" ||
          tool.capability_revision.length < 1 ||
          tool.capability_revision.length > 256 ||
          !phase.allowed_tools.includes(tool?.capability_id))) {
      fail("EG_PHASE_TOOL_NOT_ALLOWED", "Capsule widens phase tools");
    }
    if (capsule.allowed_tools.some((tool) =>
      !phase.allowed_effect_classes.includes(tool.effect_class))) {
      fail("EG_PHASE_EFFECT_CLASS_NOT_ALLOWED", "Capsule widens phase effects");
    }
  }

  #expire(current) {
    if (this.#status !== "active") return;
    if (!Number.isFinite(current)) {
      fail("EG_PHASE_TRANSITION_DENIED", "transaction clock is invalid");
    }
    if (this.#activeExpiry <= current) {
      this.#expiredDigest = this.#activeDigest;
      this.#activeDigest = undefined;
      this.#activeExpiry = undefined;
      this.#status = "awaiting_capsule";
    }
  }

  #timestamp() {
    const value = this.#now();
    if (!Number.isFinite(value)) {
      fail("EG_PHASE_TRANSITION_DENIED", "transaction clock is invalid");
    }
    return new Date(value).toISOString();
  }
}
