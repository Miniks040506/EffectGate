import assert from "node:assert/strict";
import {
  mkdtempSync, readFileSync, readdirSync, rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runSkillFixtureBenchmark } from "../src/benchmark/skill-fixture-runner.mjs";

test("Skill profiles share a fixture and retain verified S3 evidence", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "effectgate-skill-bench-"));
  const file = join(workspace, "evidence.jsonl");
  try {
    const result = await runSkillFixtureBenchmark({ file, workspace });
    assert.deepEqual(
      new Set(result.events.map(({ profile }) => profile)),
      new Set([
        "S1_FULL_LOAD_DIAGNOSTIC",
        "S2_EG_CAPSULE",
        "S3_EG_CAPSULE_VERIFIED"
      ])
    );
    const profiles = Object.fromEntries(result.events.map(
      (event) => [event.profile, event]
    ));
    assert.equal(profiles.S1_FULL_LOAD_DIAGNOSTIC.status, "completed");
    assert.equal(profiles.S1_FULL_LOAD_DIAGNOSTIC.metrics.task_success, true);
    assert.equal(profiles.S2_EG_CAPSULE.status, "completed");
    assert.equal(profiles.S2_EG_CAPSULE.metrics.task_success, true);
    const s2 = profiles.S2_EG_CAPSULE.metrics;
    assert.equal(s2.safety_invariant_available, true);
    assert.equal(s2.protected_effect_policy_violations, 0);
    assert.equal(s2.instruction_fetch_count, 1);
    assert.ok(s2.phase_receipt_tokens.value > 0);
    assert.ok(
      profiles.S1_FULL_LOAD_DIAGNOSTIC.metrics.skill_instruction_tokens.value > 0
    );
    assert.ok(s2.skill_instruction_tokens.value > 0);
    const s3Event = profiles.S3_EG_CAPSULE_VERIFIED;
    assert.equal(s3Event.status, "completed");
    const s3 = s3Event.metrics;
    assert.equal(s3.task_success, true);
    assert.equal(s3.duplicate_write_count, 0);
    assert.equal(s3.wrong_phase_transition, false);
    assert.equal(s3.tool_call_count, 3);
    assert.ok(s3.verification_tokens.value > 0);
    assert.ok(s3.phase_receipt_tokens.value > 0);
    const retained = readdirSync(workspace);
    assert.ok(retained.some((name) => name.endsWith("-effect.db")));
    assert.ok(retained.some((name) => name.endsWith("-skill.db")));
    const ledgerText = readFileSync(
      join(workspace, `${s3Event.run_id}.jsonl`),
      "utf8"
    );
    const [ledgerHeader, ...ledgerEntries] = ledgerText.trimEnd()
      .split("\n").map(JSON.parse);
    assert.equal(ledgerHeader.run_id, s3Event.run_id);
    assert.equal(ledgerHeader.session_id, s3Event.pair_id);
    assert.equal(ledgerHeader.profile, "native_deferred");
    const ledgerValues = Object.fromEntries(ledgerEntries.map((entry) => [
      entry.safe_metadata.category,
      entry.token_count.value
    ]));
    assert.deepEqual(new Set(Object.keys(ledgerValues)), new Set([
      "skill_catalog_tokens_emitted",
      "skill_instruction_tokens_emitted",
      "instruction_dependency_fetch_tokens",
      "phase_receipt_tokens_emitted",
      "verification_overhead_tokens"
    ]));
    assert.equal(
      ledgerValues.skill_instruction_tokens_emitted,
      s3.skill_instruction_tokens.value
    );
    assert.equal(
      ledgerValues.instruction_dependency_fetch_tokens,
      s3.instruction_fetch_tokens.value
    );
    assert.equal(
      ledgerValues.phase_receipt_tokens_emitted,
      s3.phase_receipt_tokens.value
    );
    assert.equal(
      ledgerValues.verification_overhead_tokens,
      s3.verification_tokens.value
    );
    assert.doesNotMatch(
      ledgerText,
      /Verified fixture content|Inspection reference|response loss/iu
    );
    const records = readFileSync(file, "utf8").trimEnd()
      .split("\n").map(JSON.parse);
    assert.deepEqual(records, [result.header, ...result.events]);
    await assert.rejects(runSkillFixtureBenchmark({ workspace: "" }), TypeError);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
