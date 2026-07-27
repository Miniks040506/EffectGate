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

import {
  SkillSourceError,
  importSkillSource
} from "../src/skill/source-import.mjs";
import { resolveSkillGraph } from "../src/skill/skill-graph.mjs";

function importedSource() {
  const root = mkdtempSync(join(tmpdir(), "effectgate-graph-"));
  const files = {
    "SKILL.md": "# Document editor\n",
    "phases/inspect.md": "Inspect.\n",
    "phases/modify.md": "Modify.\n",
    "phases/verify.md": "Verify.\n",
    "references/file-types.md": "Types.\n"
  };
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return {
    root,
    source: importSkillSource({ root, paths: Object.keys(files) }),
    close() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function graphInput(source) {
  return {
    source,
    invariants: [{
      id: "preserve-original",
      source_ref: "SKILL.md#safety"
    }],
    phases: {
      inspect: {
        instruction_refs: ["phases/inspect.md"],
        dependency_refs: ["references/file-types.md"],
        allowed_tools: ["filesystem.read"],
        allowed_effect_classes: ["observe"],
        transition: { on_success: "modify" }
      },
      modify: {
        instruction_refs: ["phases/modify.md"],
        allowed_tools: ["filesystem.apply_patch"],
        allowed_effect_classes: ["mutate_reversible"],
        transition: { on_success: "verify" }
      },
      verify: {
        instruction_refs: ["phases/verify.md"],
        allowed_tools: ["renderer.preview"],
        allowed_effect_classes: ["observe"]
      }
    },
    declaredTools: [
      "filesystem.apply_patch",
      "filesystem.read",
      "renderer.preview"
    ],
    declaredEffectClasses: ["mutate_reversible", "observe"]
  };
}

function assertCode(code, operation) {
  assert.throws(operation, (error) =>
    error instanceof SkillSourceError && error.code === code);
}

test("skill graph resolves references and proves success termination", () => {
  const files = importedSource();
  try {
    const graph = resolveSkillGraph(graphInput(files.source));
    assert.deepEqual(graph.phase_order, ["inspect", "modify", "verify"]);
    assert.deepEqual(graph.referenced_paths, [
      "SKILL.md",
      "phases/inspect.md",
      "phases/modify.md",
      "phases/verify.md",
      "references/file-types.md"
    ]);
    assert.ok(Object.isFrozen(graph));
  } finally {
    files.close();
  }
});

test("skill graph rejects incomplete or unsafe declarations", () => {
  const files = importedSource();
  const cases = [
    ["EG_SKILL_DEPENDENCY_MISSING", (value) => {
      value.phases.inspect.dependency_refs = ["references/missing.md"];
    }],
    ["EG_SKILL_SOURCE_INVALID", (value) => {
      value.phases.inspect.dependency_refs = ["../outside.md"];
    }],
    ["EG_PHASE_TRANSITION_DENIED", (value) => {
      value.phases.inspect.transition.on_success = "unknown";
    }],
    ["EG_PHASE_TRANSITION_DENIED", (value) => {
      value.phases.verify.transition = { on_success: "inspect" };
    }],
    ["EG_PHASE_TRANSITION_DENIED", (value) => {
      value.phases.modify.transition.on_failure = "modify";
    }],
    ["EG_PHASE_TOOL_NOT_ALLOWED", (value) => {
      value.phases.modify.allowed_tools = ["shell.execute"];
    }],
    ["EG_PHASE_EFFECT_CLASS_NOT_ALLOWED", (value) => {
      value.phases.modify.allowed_effect_classes = ["code_execution"];
    }],
    ["EG_SKILL_SOURCE_INVALID", (value) => {
      value.invariants.push({ ...value.invariants[0] });
    }]
  ];

  try {
    for (const [code, mutate] of cases) {
      const value = graphInput(files.source);
      mutate(value);
      assertCode(code, () => resolveSkillGraph(value));
    }
  } finally {
    files.close();
  }
});
