import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../src/skill/passport-compiler.mjs";
import { TargetCorpusBatchStore } from
  "../src/benchmark/target-corpus-batch.mjs";

const CLI = fileURLToPath(new URL(
  "../src/benchmark/target-corpus-batch.mjs", import.meta.url
));
const COMMIT = "a".repeat(40);
const NOW = Date.parse("2026-08-18T00:00:00.000Z");

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function capture(file, slot, sourceCommit = COMMIT) {
  const raw = digest(`raw:${slot.task_id}:${slot.repetition}:${slot.profile}`);
  const value = {
    host_version: "2.1.233",
    kind: "effectgate_claude_host_capture",
    observed_at: "2026-08-18T00:00:00.000Z",
    profile: slot.profile,
    raw_event_digest: raw,
    repetition: slot.repetition,
    schema_version: "1.0.0",
    source_commit: sourceCommit,
    task_id: slot.task_id,
    terminal: {
      is_error: false,
      num_turns: 2,
      result_bytes: 24,
      result_digest: digest("result"),
      total_cost_usd: 0
    },
    usage: {
      cache_creation_input_tokens: 2,
      cache_read_input_tokens: 3,
      input_tokens: 1,
      output_tokens: 4,
      total_input_tokens: {
        basis: "host_reported",
        counter_id: "claude-code-json-usage",
        counter_version: "2.1.233",
        input_digest: raw,
        value: 6
      }
    }
  };
  writeFileSync(file, `${canonicalJson(value)}\n`, "utf8");
  return file;
}

test("target corpus batches persist bounds and reject duplicate slots", () => {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-target-batch-"));
  const state = join(directory, "campaign.db");
  let store = new TargetCorpusBatchStore({ file: state, now: () => NOW });
  try {
    assert.deepEqual(store.initialize({ sourceCommit: COMMIT }).counts, {
      pending: 320,
      claimed: 0,
      completed: 0
    });
    assert.equal(store.initialize({ sourceCommit: COMMIT }).total_runs, 320);
    assert.throws(() => store.initialize({ sourceCommit: "b".repeat(40) }),
      /source commit mismatch/);

    const claim = store.claim({ authorizationId: "batch-001", limit: 2 });
    assert.equal(claim.session_limit, 2);
    assert.deepEqual(claim.slots, [
      {
        task_id: "BENCH-READ-001",
        repetition: 0,
        profile: "P0_NATIVE_DEFAULT"
      },
      {
        task_id: "BENCH-READ-001",
        repetition: 0,
        profile: "P1_EG_TYPED"
      }
    ]);
    assert.throws(() => store.claim({
      authorizationId: "batch-002",
      limit: 1
    }), /still active/);

    store.close();
    store = new TargetCorpusBatchStore({ file: state, now: () => NOW });
    assert.deepEqual(store.status().active_authorization, {
      authorization_id: "batch-001",
      session_limit: 2,
      remaining: 2
    });
    const first = capture(join(directory, "first.json"), claim.slots[0]);
    const drifted = capture(
      join(directory, "drifted.json"), claim.slots[0], "b".repeat(40)
    );
    assert.throws(() => store.record({
      authorizationId: "batch-001",
      captureFile: drifted
    }), /does not match/);
    assert.equal(store.record({
      authorizationId: "batch-001",
      captureFile: first
    }).terminal_error, false);
    assert.throws(() => store.record({
      authorizationId: "batch-001",
      captureFile: first
    }), /not authorized/);

    const second = capture(join(directory, "second.json"), claim.slots[1]);
    assert.throws(() => store.record({
      authorizationId: "wrong-batch",
      captureFile: second
    }), /not authorized/);
    store.record({ authorizationId: "batch-001", captureFile: second });
    assert.deepEqual(store.status().counts, {
      pending: 318,
      claimed: 0,
      completed: 2
    });
    assert.throws(() => store.claim({
      authorizationId: "batch-001",
      limit: 1
    }), /already used/);
    assert.throws(() => store.claim({
      authorizationId: "too-large",
      limit: 319
    }), /exceeds remaining/);
    assert.equal(store.claim({
      authorizationId: "batch-002",
      limit: 1
    }).slots.length, 1);
  } finally {
    try { store.close(); } catch {}
    rmSync(directory, { recursive: true, force: true });
  }
});

test("target corpus batch CLI initializes and claims without model execution", () => {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-target-cli-"));
  const state = join(directory, "campaign.db");
  try {
    const init = spawnSync(process.execPath, [
      CLI, "init", "--state", state, "--source-commit", COMMIT
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(init.status, 0, init.stderr);
    assert.equal(JSON.parse(init.stdout).counts.pending, 320);
    const claim = spawnSync(process.execPath, [
      CLI, "claim", "--state", state,
      "--authorization-id", "cli-batch-001", "--limit", "1"
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(claim.status, 0, claim.stderr);
    assert.equal(JSON.parse(claim.stdout).slots.length, 1);
    const status = spawnSync(process.execPath, [
      CLI, "status", "--state", state
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(status.status, 0, status.stderr);
    const value = JSON.parse(status.stdout);
    assert.equal(status.stdout, `${canonicalJson(value)}\n`);
    assert.deepEqual(value.counts, { claimed: 1, completed: 0, pending: 319 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
