import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { compileInstructionCapsule } from "../src/skill/capsule-compiler.mjs";
import { compileSkillPassport } from "../src/skill/passport-compiler.mjs";
import { SkillTransaction } from "../src/skill/phase-transaction.mjs";
import { SkillSourceError, importSkillSource } from "../src/skill/source-import.mjs";

const ARTIFACT_DIGEST = `sha256:${"a".repeat(64)}`;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "effectgate-phase-"));
  const files = {
    "SKILL.md": "Keep the original until verification.\n",
    "phases/inspect.md": "Inspect.\n",
    "phases/modify.md": "Modify.\n"
  };
  for (const [path, text] of Object.entries(files)) {
    const file = join(root, ...path.split("/"));
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  const source = importSkillSource({ root, paths: Object.keys(files) });
  const phases = {
    inspect: {
      instruction_refs: ["phases/inspect.md"],
      allowed_tools: ["filesystem.read"],
      allowed_effect_classes: ["observe"],
      transition: { on_success: "modify" }
    },
    modify: {
      instruction_refs: ["phases/modify.md"],
      allowed_tools: ["filesystem.apply_patch"],
      allowed_effect_classes: ["mutate_reversible"]
    }
  };
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
    phases,
    declaredTools: ["filesystem.read", "filesystem.apply_patch"],
    declaredEffectClasses: ["observe", "mutate_reversible"]
  });
  const capabilities = {
    "filesystem.read": { revision: "read-v1", effect_class: "observe" },
    "filesystem.apply_patch": {
      revision: "patch-v1",
      effect_class: "mutate_reversible"
    }
  };
  const capsule = (phase, phaseRevision) => compileInstructionCapsule({
    passport,
    source,
    phase,
    capabilities,
    phaseRevision,
    maxTokens: 5000,
    maxBytes: 20000,
    expiresAt: "2026-07-29T00:00:00.000Z"
  });
  return {
    passport,
    capsule,
    close() {
      rmSync(root, { recursive: true, force: true });
    }
  };
}

function assertCode(code, operation) {
  assert.throws(operation, (error) =>
    error instanceof SkillSourceError && error.code === code);
}

test("phase transaction evicts Capsules and replaces them with receipts", () => {
  const files = fixture();
  try {
    const transaction = new SkillTransaction({
      transactionId: "transaction-1",
      passport: files.passport,
      initialPhase: "inspect",
      now: () => Date.parse("2026-07-28T00:00:00.000Z")
    });
    const inspect = files.capsule("inspect", 1);
    transaction.activateCapsule(inspect);
    const first = transaction.reportPhaseOutcome({
      capsuleDigest: inspect.capsule_digest,
      status: "completed",
      inputArtifactDigests: [ARTIFACT_DIGEST],
      findingRefs: ["artifact://findings/inspect"]
    });
    assert.equal(first.next_phase, "modify");
    assert.equal(transaction.snapshot().status, "awaiting_capsule");
    assert.equal(transaction.snapshot().active_capsule_digest, null);
    assertCode("EG_PHASE_TRANSITION_DENIED", () =>
      transaction.reportPhaseOutcome({
        capsuleDigest: inspect.capsule_digest,
        status: "completed"
      }));

    const modify = files.capsule("modify", 2);
    transaction.activateCapsule(modify);
    const final = transaction.reportPhaseOutcome({
      capsuleDigest: modify.capsule_digest,
      status: "completed",
      effectReceiptRefs: ["receipt://effect/1"]
    });
    assert.equal(final.next_phase, null);
    assert.equal(transaction.snapshot().status, "completed");
    assert.equal(transaction.receipts().length, 2);
    assert.ok(Object.isFrozen(first));
  } finally {
    files.close();
  }
});
