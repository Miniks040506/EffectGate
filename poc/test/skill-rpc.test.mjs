import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";

import { compileSkillPassport } from "../src/skill/passport-compiler.mjs";
import { SkillEventStore } from "../src/skill/skill-event-store.mjs";
import { SkillRpc } from "../src/skill/skill-rpc.mjs";
import { importSkillSource } from "../src/skill/source-import.mjs";
import { SkillRpcClient } from "../src/testkit/skill-rpc-client.mjs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "effectgate-rpc-"));
  const files = {
    "SKILL.md": "Preserve the original.\n",
    "phases/inspect.md": "Inspect the input.\n",
    "phases/modify.md": "Apply the admitted change.\n"
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
      version: "1.0.0",
      trust_tier: "local_reviewed"
    },
    invariants: [{
      id: "preserve-original",
      source_ref: "SKILL.md#safety",
      pin: "transaction",
      class: "safety"
    }],
    phases: {
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
    },
    declaredTools: ["filesystem.read", "filesystem.apply_patch"],
    declaredEffectClasses: ["observe", "mutate_reversible"]
  });
  return {
    root,
    source,
    passport,
    capabilities: {
      "filesystem.read": { revision: "read-v1", effect_class: "observe" },
      "filesystem.apply_patch": {
        revision: "patch-v1",
        effect_class: "mutate_reversible"
      }
    }
  };
}

test("local Skill RPC drives and recovers a complete phase lifecycle", () => {
  const skill = fixture();
  const store = new SkillEventStore({ file: join(skill.root, "events.db") });
  let clock = Date.parse("2026-07-28T00:00:00.000Z");
  const now = () => clock;
  try {
    let client = new SkillRpcClient(new SkillRpc({
      skills: [skill], eventStore: store, now
    }));
    assert.equal(client.request("skills/list").skills[0].id, "document-editor");
    assert.equal(
      client.request("skills/passport/get", {
        skill_id: "document-editor"
      }).passport_digest,
      skill.passport.passport_digest
    );
    assert.equal(client.request("skills/transaction/start", {
      transaction_id: "rpc-transaction",
      skill_id: "document-editor",
      initial_phase: "inspect"
    }).status, "awaiting_capsule");

    const inspect = client.request("skills/capsule/get", {
      transaction_id: "rpc-transaction"
    });
    assert.equal(inspect.phase, "inspect");
    assert.deepEqual(client.request("skills/tool/admit", {
      transaction_id: "rpc-transaction",
      capsule_digest: inspect.capsule_digest,
      capability_id: "filesystem.read",
      capability_revision: "read-v1",
      effect_class: "observe"
    }), {
      schema_version: "1.0.0",
      transaction_id: "rpc-transaction",
      skill_id: "document-editor",
      skill_digest: skill.source.source_digest,
      phase: "inspect",
      phase_revision: 1,
      capsule_digest: inspect.capsule_digest,
      capability_id: "filesystem.read",
      capability_revision: "read-v1",
      effect_class: "observe"
    });
    for (const [overrides, code] of [
      [{ capability_id: "filesystem.apply_patch" },
        "EG_PHASE_TOOL_NOT_ALLOWED"],
      [{ capability_revision: "read-v2" }, "EG_PHASE_TOOL_NOT_ALLOWED"],
      [{ effect_class: "mutate_reversible" },
        "EG_PHASE_EFFECT_CLASS_NOT_ALLOWED"]
    ]) {
      assert.throws(() => client.request("skills/tool/admit", {
        transaction_id: "rpc-transaction",
        capsule_digest: inspect.capsule_digest,
        capability_id: "filesystem.read",
        capability_revision: "read-v1",
        effect_class: "observe",
        ...overrides
      }), (error) => error.effectgateCode === code);
    }
    assert.equal(client.request("skills/dependency/get", {
      transaction_id: "rpc-transaction",
      source_ref: "phases/inspect.md"
    }).text, "Inspect the input.\n");
    assert.throws(() => client.request("skills/dependency/get", {
      transaction_id: "rpc-transaction",
      source_ref: "phases/modify.md"
    }), (error) => error.effectgateCode === "EG_SKILL_DEPENDENCY_MISSING");

    client.request("skills/phase/report", {
      transaction_id: "rpc-transaction",
      capsule_digest: inspect.capsule_digest,
      status: "completed"
    });
    assert.throws(() => client.request("skills/tool/admit", {
      transaction_id: "rpc-transaction",
      capsule_digest: inspect.capsule_digest,
      capability_id: "filesystem.read",
      capability_revision: "read-v1",
      effect_class: "observe"
    }), (error) => error.effectgateCode === "EG_PHASE_TRANSITION_DENIED");
    const modify = client.request("skills/capsule/get", {
      transaction_id: "rpc-transaction"
    });

    client = new SkillRpcClient(new SkillRpc({
      skills: [skill], eventStore: store, now
    }));
    assert.equal(client.request("skills/capsule/get", {
      transaction_id: "rpc-transaction"
    }).capsule_digest, modify.capsule_digest);
    clock += 6 * 60 * 1000;
    const renewed = client.request("skills/capsule/get", {
      transaction_id: "rpc-transaction"
    });
    assert.notEqual(renewed.capsule_digest, modify.capsule_digest);
    client.request("skills/phase/report", {
      transaction_id: "rpc-transaction",
      capsule_digest: renewed.capsule_digest,
      status: "aborted"
    });
    assert.equal(client.request("skills/receipts/list", {
      transaction_id: "rpc-transaction"
    }).receipts.length, 2);
    assert.throws(() => client.request("skills/capsule/get", {
      transaction_id: "rpc-transaction"
    }), (error) => error.effectgateCode === "EG_PHASE_TRANSITION_DENIED");
    assert.throws(() => client.request("unknown", {}),
      (error) => error.rpcCode === -32601);
  } finally {
    store.close();
    rmSync(skill.root, { recursive: true, force: true });
  }
});
