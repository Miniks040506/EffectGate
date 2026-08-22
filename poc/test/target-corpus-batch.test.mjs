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
import { runObservedBenchmark } from
  "../src/benchmark/observation-runner.mjs";
import { TargetCorpusBatchStore } from
  "../src/benchmark/target-corpus-batch.mjs";

const CLI = fileURLToPath(new URL(
  "../src/benchmark/target-corpus-batch.mjs", import.meta.url
));
const HOST_EVIDENCE = fileURLToPath(new URL(
  "../evidence/host-compatibility-claude-code-2.1.233.json", import.meta.url
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

function tokenCount(value, label) {
  return {
    value,
    basis: "byte_proxy",
    counter_id: "utf8-bytes-ceil-div-4",
    counter_version: "1",
    input_digest: digest(label)
  };
}

function metrics(file, slot) {
  const raw = digest(`raw:${slot.task_id}:${slot.repetition}:${slot.profile}`);
  const resultTokens = tokenCount(1, `result:${raw}`);
  const benchmark = {
    task_success: true,
    latency_ms: 100,
    fetch_count: 0,
    tool_call_count: 1,
    tool_schema_tokens: tokenCount(2, `schema:${raw}`),
    tool_result_tokens: resultTokens,
    compatibility: slot.profile === "P1_EG_TYPED"
      ? { native_deferral: "qualified", evidence_digest: digest("host") }
      : {
          native_deferral: slot.profile === "P2_EG_MUX"
            ? "profile_not_native_deferred"
            : "not_applicable"
        }
  };
  const value = {
    benchmark_metrics: benchmark,
    fetch_count: 0,
    kind: "effectgate_claude_stream_metrics",
    latency_ms: 100,
    profile: slot.profile,
    raw_stream_digest: raw,
    repetition: slot.repetition,
    schema_version: "1.0.0",
    source_commit: COMMIT,
    task_id: slot.task_id,
    task_success: true,
    terminal_success: true,
    tool_call_count: 1,
    tool_counts: { fixture_tool: 1 },
    tool_result_tokens: resultTokens
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

test("target corpus campaign plans bind deterministic inputs and all slots", () => {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-target-plan-"));
  const state = join(directory, "campaign.db");
  const store = new TargetCorpusBatchStore({
    file: state, now: () => NOW
  });
  const configuration = {
    seed: "target-corpus-v1",
    backendDigest: digest("backend"),
    model: "claude-sonnet-5",
    effort: "medium",
    hostVersion: "2.1.233",
    machineClass: "windows-x64-test",
    observedAt: "2026-08-18T00:00:00.000Z"
  };
  try {
    store.initialize({ sourceCommit: COMMIT });
    const firstDirectory = join(directory, "first");
    const secondDirectory = join(directory, "second");
    const first = store.prepareCampaign({
      ...configuration, outputDirectory: firstDirectory
    });
    const prepared = spawnSync(process.execPath, [
      CLI, "prepare", "--state", state, "--output", secondDirectory,
      "--seed", configuration.seed,
      "--backend-digest", configuration.backendDigest,
      "--model", configuration.model, "--effort", configuration.effort,
      "--host-version", configuration.hostVersion,
      "--machine-class", configuration.machineClass,
      "--observed-at", configuration.observedAt
    ], { encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const second = JSON.parse(prepared.stdout);
    assert.equal(first.slot_count, 320);
    assert.deepEqual(
      [first.inputs_digest, first.manifest_digest, first.slots_digest],
      [second.inputs_digest, second.manifest_digest, second.slots_digest]
    );
    for (const filename of ["inputs.json", "export-manifest.json", "slots.jsonl"]) {
      assert.equal(
        readFileSync(join(firstDirectory, filename), "utf8"),
        readFileSync(join(secondDirectory, filename), "utf8")
      );
    }
    const slotFile = join(firstDirectory, "slots.jsonl");
    const slotSource = readFileSync(slotFile, "utf8");
    const slots = slotSource.trimEnd().split("\n").map(JSON.parse);
    assert.equal(slots.length, 320);
    assert.deepEqual(
      [slots[0].task_id, slots[0].repetition, slots[0].profile],
      ["BENCH-READ-001", 0, "P0_NATIVE_DEFAULT"]
    );
    assert.deepEqual(
      [slots.at(-1).task_id, slots.at(-1).repetition, slots.at(-1).profile],
      ["BENCH-TABLE-004", 19, "P3_EAGER_DIAGNOSTIC"]
    );
    const validated = spawnSync(process.execPath, [
      CLI, "validate-plan", "--state", state, "--input", firstDirectory
    ], { encoding: "utf8" });
    assert.equal(validated.status, 0, validated.stderr);
    assert.equal(JSON.parse(validated.stdout).slot_count, 320);
    store.claim({ authorizationId: "plan-batch", limit: 4 });
    const sessionFile = join(directory, "session-plan.json");
    const planned = spawnSync(process.execPath, [
      CLI, "session-plan", "--state", state, "--input", firstDirectory,
      "--authorization-id", "plan-batch", "--output", sessionFile,
      "--max-budget-usd", "0.01", "--host-evidence", HOST_EVIDENCE
    ], { encoding: "utf8" });
    assert.equal(planned.status, 0, planned.stderr);
    const summary = JSON.parse(planned.stdout);
    const sessionPlan = JSON.parse(readFileSync(sessionFile, "utf8"));
    assert.equal(summary.execution_enabled, false);
    assert.equal(summary.session_count, 4);
    assert.equal(summary.aggregate_max_budget_usd, 0.04);
    assert.equal(sessionPlan.execution_enabled, false);
    assert.equal(sessionPlan.sessions.length, 4);
    assert.ok(sessionPlan.sessions.every(({ args, command, stdout_file: file }) =>
      command === "claude" && args.includes("--max-budget-usd") &&
      args.includes("--strict-mcp-config") && args.includes("ToolSearch") &&
      args.includes("mcp__effectgate__*") && !existsSync(file)));
    assert.throws(() => store.planAuthorizedSessions({
      inputDirectory: firstDirectory,
      authorizationId: "plan-batch",
      output: join(directory, "over-budget.json"),
      maxBudgetUsd: 0.26,
      hostEvidenceFile: HOST_EVIDENCE
    }), /invalid target corpus session plan/);
    writeFileSync(slotFile, "tampered\n", "utf8");
    assert.throws(() => store.validateCampaignPlan({
      inputDirectory: firstDirectory
    }), /slot mismatch/);
    writeFileSync(slotFile, slotSource, "utf8");
    const inputFile = join(firstDirectory, "inputs.json");
    const inputs = JSON.parse(readFileSync(inputFile, "utf8"));
    inputs.tasks[0].prompt += " altered";
    writeFileSync(inputFile, `${canonicalJson(inputs)}\n`, "utf8");
    assert.throws(() => store.validateCampaignPlan({
      inputDirectory: firstDirectory
    }), /input mismatch/);
  } finally {
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("target corpus export verifies all checkpoints and emits four observations",
  async () => {
    const directory = mkdtempSync(join(tmpdir(), "effectgate-target-export-"));
    const state = join(directory, "campaign.db");
    const store = new TargetCorpusBatchStore({ file: state, now: () => NOW });
    try {
      store.initialize({ sourceCommit: COMMIT });
      const manifestFile = join(directory, "export-manifest.json");
      writeFileSync(manifestFile, `${canonicalJson({
        backend_digest: digest("backend"),
        effort: "medium",
        host_version: "2.1.233",
        kind: "effectgate_target_corpus_export",
        machine_class: "test-machine",
        model: "test-model",
        observed_at: "2026-08-18T00:00:00.000Z",
        schema_version: "1.0.0",
        seed: "target-export-test",
        source_commit: COMMIT,
        tasks: [
          "BENCH-READ-001", "BENCH-JSON-002", "BENCH-STREAM-003",
          "BENCH-TABLE-004"
        ].map((taskId) => ({
          task_id: taskId,
          prompt_digest: digest(`prompt:${taskId}`),
          rubric_digest: digest(`rubric:${taskId}`)
        }))
      })}\n`, "utf8");
      assert.throws(() => store.exportObservations({
        manifestFile,
        outputDirectory: join(directory, "incomplete")
      }), /campaign is incomplete/);
      const { slots } = store.claim({
        authorizationId: "export-batch",
        limit: 320
      });
      for (const [index, slot] of slots.entries()) {
        store.record({
          authorizationId: "export-batch",
          captureFile: capture(join(directory, `capture-${index}.json`), slot),
          metricsFile: metrics(join(directory, `metrics-${index}.json`), slot)
        });
      }
      const output = join(directory, "observations");
      const exported = store.exportObservations({
        manifestFile,
        outputDirectory: output
      });
      assert.equal(exported.length, 4);
      for (const item of exported) {
        const source = readFileSync(item.file, "utf8");
        const value = JSON.parse(source);
        assert.equal(source, `${canonicalJson(value)}\n`);
        assert.equal(value.runs.length, 80);
        assert.ok(value.runs.every(({ metrics: runMetrics }) =>
          runMetrics.total_input_tokens.value === 6));
      }
      const imported = await runObservedBenchmark({
        input: exported[0].file,
        output: join(directory, "observed.jsonl")
      });
      assert.equal(imported.benchmark.events.length, 80);

      writeFileSync(join(directory, "metrics-0.json"), "tampered\n", "utf8");
      assert.throws(() => store.exportObservations({
        manifestFile,
        outputDirectory: join(directory, "tampered-output")
      }), /checkpoint digest mismatch/);
    } finally {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });
