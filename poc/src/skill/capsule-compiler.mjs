import { createHash } from "node:crypto";
import { BYTE_PROXY_COUNTER } from "../budget/token-counter.mjs";
import {
  canonicalJson,
  deepFreeze,
  skillPassportDigest
} from "./passport-compiler.mjs";
import {
  SkillSourceError,
  importSkillSource
} from "./source-import.mjs";
import { skillReferencePath } from "./skill-graph.mjs";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;

function fail(code, message) {
  throw new SkillSourceError(code, message);
}

function boundedInteger(value, maximum, label) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    fail("EG_CAPSULE_BUDGET_INSUFFICIENT", `${label} is invalid`);
  }
  return value;
}

function fileFor(reference, files) {
  const path = skillReferencePath(reference);
  const file = files.get(path);
  if (!file) {
    fail("EG_SKILL_DEPENDENCY_MISSING", `missing capsule reference: ${path}`);
  }
  if (file.text.length < 1 || file.text.length > 262144) {
    fail("EG_CAPSULE_BUDGET_INSUFFICIENT", "instruction text is not bounded");
  }
  return file;
}

function verifyPassport(passport) {
  if (!passport || typeof passport !== "object" ||
      !DIGEST_PATTERN.test(passport.passport_digest ?? "")) {
    fail("EG_SKILL_SOURCE_INVALID", "passport is invalid");
  }
  const { passport_digest: claimed, ...body } = passport;
  if (skillPassportDigest(body) !== claimed) {
    fail("EG_SKILL_DIGEST_DRIFT", "passport digest does not match");
  }
}

export function instructionCapsuleDigest(body) {
  const hash = createHash("sha256").update("effectgate.instruction-capsule.v1\0");
  return `sha256:${hash.update(canonicalJson(body)).digest("hex")}`;
}

export function compileInstructionCapsule({
  passport,
  source,
  phase,
  capabilities,
  maxTokens,
  maxBytes,
  expiresAt,
  phaseRevision = 1
} = {}) {
  verifyPassport(passport);
  if (passport.skill.source_digest !== source?.source_digest) {
    fail("EG_SKILL_DIGEST_DRIFT", "passport and source digests differ");
  }
  if (typeof expiresAt !== "string" || Number.isNaN(Date.parse(expiresAt))) {
    fail("EG_SKILL_SOURCE_INVALID", "capsule expiry is invalid");
  }
  boundedInteger(phaseRevision, Number.MAX_SAFE_INTEGER, "phaseRevision");
  boundedInteger(maxTokens, 1000000, "maxTokens");
  boundedInteger(maxBytes, 16777216, "maxBytes");

  const phaseContract = passport.phases?.[phase];
  if (!phaseContract) {
    fail("EG_PHASE_TRANSITION_DENIED", "capsule phase is unknown");
  }
  const refreshed = importSkillSource({
    root: source.root,
    paths: source.files.map((file) => file.path),
    expectedDigest: source.source_digest
  });
  const files = new Map(refreshed.files.map((file) => [file.path, file]));
  const dependencies = new Set();
  const instruction = (id, reference) => {
    const file = fileFor(reference, files);
    dependencies.add(file.digest);
    return { id, text: file.text, source_ref: reference };
  };

  const invariants = passport.invariants.map((invariant) =>
    instruction(invariant.id, invariant.source_ref));
  const refs = [...new Set([
    ...phaseContract.instruction_refs,
    ...(phaseContract.dependency_refs ?? [])
  ])];
  if (refs.length < 1 || refs.length > 256) {
    fail("EG_CAPSULE_BUDGET_INSUFFICIENT", "phase dependency closure is invalid");
  }
  const instructions = refs.map((reference, index) =>
    instruction(`instruction-${String(index + 1).padStart(4, "0")}`, reference));

  if (!capabilities || typeof capabilities !== "object" ||
      Array.isArray(capabilities)) {
    fail("EG_PHASE_TOOL_NOT_ALLOWED", "capability revisions are required");
  }
  const allowedTools = phaseContract.allowed_tools.map((capabilityId) => {
    const capability = capabilities[capabilityId];
    if (!Object.hasOwn(capabilities, capabilityId) || !capability ||
        typeof capability.revision !== "string" ||
        capability.revision.length < 1 || capability.revision.length > 256) {
      fail("EG_PHASE_TOOL_NOT_ALLOWED", `capability is not pinned: ${capabilityId}`);
    }
    if (!phaseContract.allowed_effect_classes.includes(capability.effect_class)) {
      fail(
        "EG_PHASE_EFFECT_CLASS_NOT_ALLOWED",
        `capability effect is not admitted: ${capabilityId}`
      );
    }
    return {
      capability_id: capabilityId,
      capability_revision: capability.revision,
      effect_class: capability.effect_class
    };
  });

  const budget = { max_tokens: maxTokens, max_bytes: maxBytes };
  const seed = canonicalJson({
    passport_digest: passport.passport_digest,
    phase,
    phase_revision: phaseRevision,
    budget,
    expires_at: expiresAt
  });
  const capsuleId = `cap_${createHash("sha256").update(seed)
    .digest("hex").slice(0, 24)}`;
  const body = {
    schema_version: "1.0.0",
    capsule_id: capsuleId,
    skill_id: passport.skill.id,
    skill_version: passport.skill.version,
    skill_digest: passport.skill.source_digest,
    phase,
    phase_revision: phaseRevision,
    invariants,
    instructions,
    allowed_tools: allowedTools,
    transition_conditions: {
      success: phaseContract.transition?.on_success ?? "complete",
      failure: phaseContract.transition?.on_failure ?? "remain_or_abort"
    },
    budget,
    provenance: {
      compiler_version: passport.compiler_version,
      passport_digest: passport.passport_digest,
      dependency_digests: [...dependencies].sort()
    },
    expires_at: expiresAt
  };
  const capsuleDigest = instructionCapsuleDigest(body);
  const capsule = { ...body, capsule_digest: capsuleDigest };
  const encoded = canonicalJson(capsule);
  if (Buffer.byteLength(encoded) > maxBytes ||
      BYTE_PROXY_COUNTER.measure({ content: encoded }).value > maxTokens) {
    fail(
      "EG_CAPSULE_BUDGET_INSUFFICIENT",
      "complete phase instructions exceed capsule budget"
    );
  }
  return deepFreeze(capsule);
}
