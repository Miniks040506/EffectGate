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
  #activeDigest; #id; #now; #passport; #phase;
  #receipts = [];
  #revision = 1;
  #status = "awaiting_capsule";

  constructor({ transactionId, passport, initialPhase, now = Date.now } = {}) {
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
  }

  snapshot() {
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

  activateCapsule(capsule) {
    if (this.#status !== "awaiting_capsule") {
      fail("EG_PHASE_TRANSITION_DENIED", "transaction is not awaiting a Capsule");
    }
    verifyCapsule(capsule);
    if (capsule.phase !== this.#phase ||
        capsule.phase_revision !== this.#revision ||
        capsule.skill_id !== this.#passport.skill.id ||
        capsule.skill_version !== this.#passport.skill.version ||
        capsule.skill_digest !== this.#passport.skill.source_digest ||
        capsule.provenance?.passport_digest !==
          this.#passport.passport_digest) {
      fail("EG_SKILL_DIGEST_DRIFT", "Capsule is not bound to this phase");
    }
    const expiry = Date.parse(capsule.expires_at);
    const now = this.#now();
    if (!Number.isFinite(expiry) || !Number.isFinite(now) || expiry <= now) {
      fail("EG_PHASE_TRANSITION_DENIED", "Capsule has expired");
    }
    const included = new Set(capsule.invariants?.map((item) => item.id));
    if (this.#passport.invariants.some((item) => !included.has(item.id))) {
      fail("EG_CAPSULE_INVARIANT_MISSING", "pinned invariant is absent");
    }
    this.#activeDigest = capsule.capsule_digest;
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
    this.#receipts.push(receipt);
    this.#activeDigest = undefined;
    if (nextPhase === null) {
      this.#phase = null;
      this.#status = status;
    } else {
      this.#phase = nextPhase;
      this.#revision += 1;
      this.#status = "awaiting_capsule";
    }
    return receipt;
  }
}
