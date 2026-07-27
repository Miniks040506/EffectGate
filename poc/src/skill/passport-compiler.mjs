import { createHash } from "node:crypto";

import {
  SkillSourceError,
  importSkillSource
} from "./source-import.mjs";
import { resolveSkillGraph } from "./skill-graph.mjs";

export const SKILL_COMPILER_VERSION = "0.1.0";

const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const VERSION_PATTERN =
  /^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const TRUST_TIERS = new Set([
  "untrusted", "local_unverified", "local_reviewed",
  "verified_local", "signed_trusted"
]);
const INVARIANT_CLASSES = new Set([
  "safety", "authority", "permission", "legal", "destructive_action"
]);
const EFFECT_CLASSES = new Set([
  "observe", "disclose", "mutate_reversible", "mutate_irreversible",
  "destructive", "external_commit", "credential_use", "code_execution",
  "unknown"
]);

function fail(message) {
  throw new SkillSourceError("EG_SKILL_SOURCE_INVALID", message);
}

function exactObject(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).some((key) => !allowed.includes(key))) {
    fail(`${label} contains invalid fields`);
  }
}

function boundedString(value, maximum, pattern, label) {
  if (typeof value !== "string" || value.length < 1 ||
      value.length > maximum || (pattern && !pattern.test(value))) {
    fail(`${label} is invalid`);
  }
  return value;
}

function uniqueList(value, maximum, label) {
  if (!Array.isArray(value) || value.length > maximum ||
      new Set(value).size !== value.length) {
    fail(`${label} must be a bounded unique array`);
  }
  return [...value];
}

function normalizePhase(phase) {
  exactObject(phase, [
    "instruction_refs", "dependency_refs", "allowed_tools",
    "allowed_effect_classes", "transition"
  ], "phase");
  const instructionRefs = uniqueList(
    phase.instruction_refs,
    128,
    "instruction_refs"
  );
  if (instructionRefs.length === 0) fail("phase requires instructions");
  for (const ref of instructionRefs) boundedString(ref, 1024, null, "reference");

  const dependencyRefs = uniqueList(
    phase.dependency_refs ?? [],
    256,
    "dependency_refs"
  ).sort();
  for (const ref of dependencyRefs) boundedString(ref, 1024, null, "reference");
  const tools = uniqueList(phase.allowed_tools, 256, "allowed_tools").sort();
  for (const tool of tools) boundedString(tool, 512, null, "tool");
  const effects = uniqueList(
    phase.allowed_effect_classes,
    16,
    "allowed_effect_classes"
  ).sort();
  if (effects.some((effect) => !EFFECT_CLASSES.has(effect))) {
    fail("phase contains an invalid effect class");
  }

  const normalized = {
    instruction_refs: instructionRefs,
    allowed_tools: tools,
    allowed_effect_classes: effects
  };
  if (dependencyRefs.length > 0) normalized.dependency_refs = dependencyRefs;
  if (phase.transition !== undefined) {
    exactObject(
      phase.transition,
      ["on_success", "on_failure"],
      "transition"
    );
    const transition = {};
    if (phase.transition.on_success !== undefined) {
      transition.on_success = phase.transition.on_success;
    }
    if (phase.transition.on_failure !== undefined) {
      transition.on_failure = phase.transition.on_failure;
    }
    if (Object.keys(transition).length === 0) fail("transition cannot be empty");
    normalized.transition = transition;
  }
  return normalized;
}

export function canonicalJson(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  return `{${Object.keys(value).sort().map((key) =>
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
}

export function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function skillPassportDigest(body) {
  return `sha256:${createHash("sha256")
    .update("effectgate.skill-passport.v1\0")
    .update(canonicalJson(body))
    .digest("hex")}`;
}

export function compileSkillPassport({
  source,
  skill,
  invariants,
  phases,
  declaredTools,
  declaredEffectClasses,
  compilerVersion = SKILL_COMPILER_VERSION
} = {}) {
  exactObject(skill, ["id", "version", "trust_tier"], "skill");
  const normalizedSkill = {
    id: boundedString(skill.id, 128, NAME_PATTERN, "skill id"),
    version: boundedString(skill.version, 128, VERSION_PATTERN, "skill version"),
    source_digest: source?.source_digest,
    trust_tier: skill.trust_tier
  };
  if (!TRUST_TIERS.has(normalizedSkill.trust_tier)) fail("trust tier is invalid");
  boundedString(compilerVersion, 128, VERSION_PATTERN, "compiler version");

  const refreshed = importSkillSource({
    root: source?.root,
    paths: source?.files?.map((file) => file.path),
    expectedDigest: source?.source_digest
  });
  const graph = resolveSkillGraph({
    source: refreshed,
    invariants,
    phases,
    declaredTools,
    declaredEffectClasses
  });

  const normalizedInvariants = uniqueList(invariants, 256, "invariants")
    .map((invariant) => {
      exactObject(invariant, ["id", "source_ref", "pin", "class"], "invariant");
      if (invariant.pin !== "transaction" ||
          !INVARIANT_CLASSES.has(invariant.class)) {
        fail("invariant pin or class is invalid");
      }
      return {
        id: invariant.id,
        source_ref: invariant.source_ref,
        pin: invariant.pin,
        class: invariant.class
      };
    })
    .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
  const normalizedPhases = Object.fromEntries(
    graph.phase_order.map((name) => [name, normalizePhase(phases[name])])
  );
  const body = {
    schema_version: "1.0.0",
    skill: normalizedSkill,
    invariants: normalizedInvariants,
    phases: normalizedPhases,
    compiler_version: compilerVersion
  };
  const passportDigest = skillPassportDigest(body);
  return deepFreeze({ ...body, passport_digest: passportDigest });
}
