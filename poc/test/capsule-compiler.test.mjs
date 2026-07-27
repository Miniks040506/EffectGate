import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { compileInstructionCapsule } from "../src/skill/capsule-compiler.mjs";
import { compileSkillPassport } from "../src/skill/passport-compiler.mjs";
import { SkillSourceError, importSkillSource } from "../src/skill/source-import.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "effectgate-capsule-"));
  const files = {
    "SKILL.md": "Never replace the original before verification.\n",
    "phases/modify.md": "Apply only the admitted patch.\n",
    "references/format.md": "Preserve the document format.\n"
  };
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const source = importSkillSource({ root, paths: Object.keys(files) });
  const passport = compileSkillPassport({
    source,
    skill: {
      id: "document-editor",
      version: "1.4.0",
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
        dependency_refs: ["references/format.md"],
        allowed_tools: ["filesystem.apply_patch"],
        allowed_effect_classes: ["mutate_reversible"]
      }
    },
    declaredTools: ["filesystem.apply_patch"],
    declaredEffectClasses: ["mutate_reversible"]
  });
  return {
    root,
    source,
    passport,
    options: {
      passport,
      source,
      phase: "modify",
      capabilities: {
        "filesystem.apply_patch": {
          revision: "sha256:capability-v1",
          effect_class: "mutate_reversible"
        }
      },
      maxTokens: 5000,
      maxBytes: 20000,
      expiresAt: "2026-07-28T00:00:00.000Z"
    },
    close() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function assertCode(code, operation) {
  assert.throws(operation, (error) =>
    error instanceof SkillSourceError && error.code === code);
}

test("Capsule compilation is deterministic, phase-only, and invariant-pinned", () => {
  const files = fixture();
  try {
    const capsule = compileInstructionCapsule(files.options);
    assert.deepEqual(compileInstructionCapsule(files.options), capsule);
    assert.equal(capsule.invariants[0].id, "preserve-original");
    assert.deepEqual(
      capsule.instructions.map((item) => item.source_ref),
      ["phases/modify.md", "references/format.md"]
    );
    assert.equal(capsule.allowed_tools[0].capability_revision,
      "sha256:capability-v1");
    assert.match(capsule.capsule_digest, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(Object.isFrozen(capsule.instructions[0]));

    assertCode("EG_CAPSULE_BUDGET_INSUFFICIENT", () =>
      compileInstructionCapsule({ ...files.options, maxBytes: 100 }));
    assertCode("EG_PHASE_EFFECT_CLASS_NOT_ALLOWED", () =>
      compileInstructionCapsule({
        ...files.options,
        capabilities: {
          "filesystem.apply_patch": {
            revision: "v2",
            effect_class: "observe"
          }
        }
      }));
    assertCode("EG_SKILL_DIGEST_DRIFT", () =>
      compileInstructionCapsule({
        ...files.options,
        passport: { ...files.passport, passport_digest: `sha256:${"0".repeat(64)}` }
      }));

    writeFileSync(join(files.root, "SKILL.md"), "Changed safety rule.\n");
    assertCode("EG_SKILL_DIGEST_DRIFT", () =>
      compileInstructionCapsule(files.options));
  } finally {
    files.close();
  }
});
