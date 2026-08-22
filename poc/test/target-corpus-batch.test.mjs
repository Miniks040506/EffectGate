import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
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

function stream(file, complete = true) {
  const events = [
    { type: "system", subtype: "init" },
    { type: "assistant", message: { content: [{
      type: "tool_use", id: "tool_1",
      name: "mcp__effectgate__effectgate_fetch", input: { secret: "hidden" }
    }] } },
    ...(complete ? [{ type: "user", message: { content: [{
      type: "tool_result", tool_use_id: "tool_1", content: "hidden"
    }] } }] : []),
    {
      type: "result", subtype: "success", is_error: false,
      result: "hidden", num_turns: 2, duration_ms: 100,
      total_cost_usd: 0,
      usage: {
        input_tokens: 1, cache_creation_input_tokens: 2,
        cache_read_input_tokens: 3, output_tokens: 4
      }
    }
  ];
  writeFileSync(file, `${events.map(JSON.stringify).join("\n")}\n`, "utf8");
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
    const slot = JSON.parse(claim.stdout).slots[0];
    const raw = stream(join(directory, "raw.jsonl"));
    const record = spawnSync(process.execPath, [
      CLI, "record-stream", "--state", state,
      "--authorization-id", "cli-batch-001", "--stream", raw,
      "--capture", join(directory, "capture.json"),
      "--metrics", join(directory, "metrics.json"),
      "--task-id", slot.task_id, "--profile", slot.profile,
      "--repetition", String(slot.repetition), "--host-version", "2.1.238",
      "--observed-at", "2026-08-18T00:00:00.000Z"
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(record.status, 0, record.stderr);
    assert.equal(JSON.parse(record.stdout).raw_stream_deleted, true);
    const status = spawnSync(process.execPath, [
      CLI, "status", "--state", state
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(status.status, 0, status.stderr);
    const value = JSON.parse(status.stdout);
    assert.equal(status.stdout, `${canonicalJson(value)}\n`);
    assert.deepEqual(value.counts, { claimed: 0, completed: 1, pending: 319 });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("target corpus stream checkpoint deletes raw input only after success", () => {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-target-stream-"));
  const state = join(directory, "campaign.db");
  const store = new TargetCorpusBatchStore({ file: state, now: () => NOW });
  try {
    store.initialize({ sourceCommit: COMMIT });
    const { slots } = store.claim({ authorizationId: "stream-batch", limit: 2 });
    const raw = join(directory, "raw.jsonl");
    const captureFile = join(directory, "capture.json");
    const metricsFile = join(directory, "metrics.json");
    stream(raw);
    const first = slots[0];
    const checkpoint = store.recordStream({
      authorizationId: "stream-batch",
      streamFile: raw,
      captureFile,
      metricsFile,
      taskId: first.task_id,
      profile: first.profile,
      repetition: first.repetition,
      hostVersion: "2.1.238",
      observedAt: "2026-08-18T00:00:00.000Z"
    });
    assert.equal(checkpoint.raw_stream_deleted, true);
    assert.equal(existsSync(raw), false);
    assert.equal(readFileSync(captureFile, "utf8").includes("hidden"), false);
    assert.equal(readFileSync(metricsFile, "utf8").includes("hidden"), false);

    const invalidRaw = join(directory, "invalid.jsonl");
    stream(invalidRaw, false);
    const second = slots[1];
    assert.throws(() => store.recordStream({
      authorizationId: "stream-batch",
      streamFile: invalidRaw,
      captureFile: join(directory, "invalid-capture.json"),
      metricsFile: join(directory, "invalid-metrics.json"),
      taskId: second.task_id,
      profile: second.profile,
      repetition: second.repetition,
      hostVersion: "2.1.238",
      observedAt: "2026-08-18T00:00:00.000Z"
    }), /incomplete Claude stream tool results/);
    assert.equal(existsSync(invalidRaw), true);
    assert.deepEqual(store.status().counts, {
      pending: 318, claimed: 1, completed: 1
    });
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
