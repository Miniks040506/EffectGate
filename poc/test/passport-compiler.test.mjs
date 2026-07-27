import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { compileSkillPassport } from "../src/skill/passport-compiler.mjs";
import { SkillSourceError, importSkillSource } from "../src/skill/source-import.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "effectgate-compiler-"));
  const files = {
    "SKILL.md": "# Editor\n",
    "phases/inspect.md": "Inspect.\n",
    "phases/modify.md": "Modify.\n",
    "phases/verify.md": "Verify.\n"
  };
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const source = importSkillSource({ root, paths: Object.keys(files) });
  const input = {
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
      verify: {
        instruction_refs: ["phases/verify.md"],
        allowed_tools: ["renderer.preview"],
        allowed_effect_classes: ["observe"]
      },
      modify: {
        instruction_refs: ["phases/modify.md"],
        allowed_tools: ["filesystem.apply_patch"],
        allowed_effect_classes: ["mutate_reversible"],
        transition: { on_success: "verify" }
      },
      inspect: {
        instruction_refs: ["phases/inspect.md"],
        allowed_tools: ["filesystem.read"],
        allowed_effect_classes: ["observe"],
        transition: { on_success: "modify" }
      }
    },
    declaredTools: [
      "renderer.preview",
      "filesystem.read",
      "filesystem.apply_patch"
    ],
    declaredEffectClasses: ["observe", "mutate_reversible"]
  };
  return {
    root,
    input,
    close() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

test("Passport compilation is deterministic, strict, and source-pinned", () => {
  const files = fixture();
  try {
    const first = compileSkillPassport(files.input);
    const second = compileSkillPassport({
      ...files.input,
      phases: Object.fromEntries(Object.entries(files.input.phases).reverse()),
      declaredTools: [...files.input.declaredTools].reverse()
    });
    assert.deepEqual(second, first);
    assert.deepEqual(Object.keys(first.phases), ["inspect", "modify", "verify"]);
    assert.equal(first.skill.source_digest, files.input.source.source_digest);
    assert.match(first.passport_digest, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(Object.isFrozen(first.phases.modify));

    assert.throws(
      () => compileSkillPassport({
        ...files.input,
        skill: { ...files.input.skill, unexpected: true }
      }),
      (error) => error instanceof SkillSourceError &&
        error.code === "EG_SKILL_SOURCE_INVALID"
    );

    writeFileSync(join(files.root, "SKILL.md"), "# Drifted\n");
    assert.throws(
      () => compileSkillPassport(files.input),
      (error) => error instanceof SkillSourceError &&
        error.code === "EG_SKILL_DIGEST_DRIFT"
    );
  } finally {
    files.close();
  }
});
