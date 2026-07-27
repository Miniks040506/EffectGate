import {
  SkillSourceError,
  canonicalSkillPath
} from "./source-import.mjs";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;

function fail(code, message) {
  throw new SkillSourceError(code, message);
}

function stringSet(value, label) {
  if (!Array.isArray(value) ||
      value.some((item) => typeof item !== "string" || item.length === 0) ||
      new Set(value).size !== value.length) {
    fail("EG_SKILL_SOURCE_INVALID", `${label} must be unique strings`);
  }
  return new Set(value);
}

export function skillReferencePath(reference) {
  if (typeof reference !== "string" ||
      reference.length < 1 || reference.length > 1024) {
    fail("EG_SKILL_SOURCE_INVALID", "skill reference must be bounded");
  }
  const separator = reference.indexOf("#");
  return canonicalSkillPath(
    separator === -1 ? reference : reference.slice(0, separator)
  );
}

function requireReference(reference, sourcePaths, resolved) {
  const path = skillReferencePath(reference);
  if (!sourcePaths.has(path)) {
    fail("EG_SKILL_DEPENDENCY_MISSING", `missing imported reference: ${path}`);
  }
  resolved.add(path);
}

function phaseEntries(phases) {
  if (phases === null || typeof phases !== "object" ||
      Array.isArray(phases)) {
    fail("EG_SKILL_SOURCE_INVALID", "phases must be an object");
  }
  const entries = Object.entries(phases).sort(([left], [right]) =>
    left < right ? -1 : left > right ? 1 : 0);
  if (entries.length < 1 || entries.length > 128 ||
      entries.some(([name]) => !NAME_PATTERN.test(name))) {
    fail("EG_SKILL_SOURCE_INVALID", "phases must have bounded canonical names");
  }
  return entries;
}

function proveSuccessPathsTerminate(entries) {
  const phases = new Map(entries);
  const visiting = new Set();
  const complete = new Set();

  function visit(name) {
    if (complete.has(name)) return;
    if (visiting.has(name)) {
      fail("EG_PHASE_TRANSITION_DENIED", "transition cycle is not bounded");
    }
    visiting.add(name);
    for (const next of Object.values(phases.get(name).transition ?? {})) {
      visit(next);
    }
    visiting.delete(name);
    complete.add(name);
  }
  for (const [name] of entries) visit(name);
}

export function resolveSkillGraph({
  source,
  invariants,
  phases,
  declaredTools,
  declaredEffectClasses
} = {}) {
  if (!source || !Array.isArray(source.files) ||
      !DIGEST_PATTERN.test(source.source_digest ?? "")) {
    fail("EG_SKILL_SOURCE_INVALID", "source must be an imported snapshot");
  }
  const sourcePaths = new Set(
    source.files.map((file) => canonicalSkillPath(file.path))
  );
  if (sourcePaths.size !== source.files.length) {
    fail("EG_SKILL_SOURCE_INVALID", "imported source paths must be unique");
  }
  const tools = stringSet(declaredTools, "declaredTools");
  const effects = stringSet(declaredEffectClasses, "declaredEffectClasses");
  const entries = phaseEntries(phases);
  const phaseNames = new Set(entries.map(([name]) => name));
  const resolved = new Set();

  if (!Array.isArray(invariants)) {
    fail("EG_SKILL_SOURCE_INVALID", "invariants must be an array");
  }
  const invariantIds = new Set();
  for (const invariant of invariants) {
    if (!invariant || !NAME_PATTERN.test(invariant.id ?? "") ||
        invariantIds.has(invariant.id)) {
      fail("EG_SKILL_SOURCE_INVALID", "invariant IDs must be unique");
    }
    invariantIds.add(invariant.id);
    requireReference(invariant.source_ref, sourcePaths, resolved);
  }

  for (const [, phase] of entries) {
    if (!phase || typeof phase !== "object") {
      fail("EG_SKILL_SOURCE_INVALID", "phase must be an object");
    }
    const instructions = stringSet(
      phase.instruction_refs,
      "instruction_refs"
    );
    if (instructions.size < 1) {
      fail("EG_SKILL_SOURCE_INVALID", "phase requires instructions");
    }
    const dependencies = stringSet(
      phase.dependency_refs ?? [],
      "dependency_refs"
    );
    for (const reference of [...instructions, ...dependencies]) {
      requireReference(reference, sourcePaths, resolved);
    }
    for (const tool of stringSet(phase.allowed_tools, "allowed_tools")) {
      if (!tools.has(tool)) {
        fail("EG_PHASE_TOOL_NOT_ALLOWED", `undeclared phase tool: ${tool}`);
      }
    }
    for (const effect of stringSet(
      phase.allowed_effect_classes,
      "allowed_effect_classes"
    )) {
      if (!effects.has(effect)) {
        fail(
          "EG_PHASE_EFFECT_CLASS_NOT_ALLOWED",
          `undeclared phase effect class: ${effect}`
        );
      }
    }
    for (const target of Object.values(phase.transition ?? {})) {
      if (typeof target !== "string" || !phaseNames.has(target)) {
        fail("EG_PHASE_TRANSITION_DENIED", "transition target is unknown");
      }
    }
  }

  proveSuccessPathsTerminate(entries);
  return Object.freeze({
    phase_order: Object.freeze(entries.map(([name]) => name)),
    referenced_paths: Object.freeze([...resolved].sort())
  });
}
