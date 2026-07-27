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

function skill(files = {}) {
  const root = mkdtempSync(join(tmpdir(), "effectgate-skill-"));
  const values = {
    "SKILL.md": "# Document editor\n",
    "phases/inspect.md": "Inspect before changing anything.\n",
    ...files
  };
  for (const [path, content] of Object.entries(values)) {
    const file = join(root, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return {
    root,
    close() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function assertCode(code, operation) {
  assert.throws(operation, (error) =>
    error instanceof SkillSourceError && error.code === code);
}

test("skill source import is deterministic across roots and path order", () => {
  const first = skill();
  const second = skill();
  try {
    const paths = ["phases/inspect.md", "SKILL.md"];
    const snapshot = importSkillSource({ root: first.root, paths });
    const repeated = importSkillSource({
      root: second.root,
      paths: [...paths].reverse(),
      expectedDigest: snapshot.source_digest
    });

    assert.equal(snapshot.source_digest, repeated.source_digest);
    assert.deepEqual(snapshot.files, repeated.files);
    assert.deepEqual(
      snapshot.files.map((file) => file.path),
      ["SKILL.md", "phases/inspect.md"]
    );
    assert.ok(Object.isFrozen(snapshot));
    assert.ok(Object.isFrozen(snapshot.files));
  } finally {
    first.close();
    second.close();
  }
});

test("skill source import rejects invalid boundaries and digest drift", () => {
  const source = skill();
  try {
    const valid = importSkillSource({
      root: source.root,
      paths: ["SKILL.md", "phases/inspect.md"]
    });
    writeFileSync(join(source.root, "SKILL.md"), "# Changed\n");
    assertCode("EG_SKILL_DIGEST_DRIFT", () =>
      importSkillSource({
        root: source.root,
        paths: ["SKILL.md", "phases/inspect.md"],
        expectedDigest: valid.source_digest
      }));

    assertCode("EG_SKILL_SOURCE_INVALID", () =>
      importSkillSource({ root: source.root, paths: ["phases/inspect.md"] }));
    assertCode("EG_SKILL_SOURCE_INVALID", () =>
      importSkillSource({ root: source.root, paths: ["SKILL.md", "../x"] }));
    assertCode("EG_SKILL_SOURCE_INVALID", () =>
      importSkillSource({ root: source.root, paths: ["SKILL.md", "a\\b"] }));
    assertCode("EG_SKILL_DEPENDENCY_MISSING", () =>
      importSkillSource({ root: source.root, paths: ["SKILL.md", "missing.md"] }));

    writeFileSync(join(source.root, "invalid.md"), Buffer.from([0xff]));
    assertCode("EG_SKILL_SOURCE_INVALID", () =>
      importSkillSource({ root: source.root, paths: ["SKILL.md", "invalid.md"] }));
  } finally {
    source.close();
  }
});
