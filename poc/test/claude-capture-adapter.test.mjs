import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assembleClaudeObservations,
  buildClaudeMcpDryRun,
  evaluateTargetCorpusAnswer,
  normalizeClaudeHostCapture,
  normalizeClaudeStreamCapture
} from "../src/benchmark/claude-capture-adapter.mjs";
import { BYTE_PROXY_COUNTER } from "../src/budget/token-counter.mjs";
import { TokenLedger } from "../src/budget/token-ledger.mjs";
import { runObservedBenchmark } from "../src/benchmark/observation-runner.mjs";
import { canonicalJson } from "../src/skill/passport-compiler.mjs";
import { MCP_VERSION } from "../src/proxy/effectgate.mjs";
import { RpcProcess } from "../src/testkit/rpc-process.mjs";

const ADAPTER = fileURLToPath(new URL(
  "../src/benchmark/claude-capture-adapter.mjs", import.meta.url
));
const CLAUDE_PILOT = fileURLToPath(new URL(
  "../evidence/claude-code-four-profile-pilot-2.1.233.json", import.meta.url
));
const CLAUDE_P2_REQUALIFICATION = fileURLToPath(new URL(
  "../evidence/claude-code-p2-requalification-2.1.233.json", import.meta.url
));
const CLAUDE_TARGET_P2_REQUALIFICATION = fileURLToPath(new URL(
  "../evidence/claude-code-target-p2-requalification-2.1.241.json",
  import.meta.url
));
const CLAUDE_TARGET_PAIRED_CELL = fileURLToPath(new URL(
  "../evidence/claude-code-target-paired-cell-2.1.241.json", import.meta.url
));
const COMMIT = "a".repeat(40);
const PROFILES = [
  "P0_NATIVE_DEFAULT",
  "P1_EG_TYPED",
  "P2_EG_MUX",
  "P3_EAGER_DIAGNOSTIC"
];

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function count(value, label) {
  return {
    basis: "byte_proxy",
    counter_id: "utf8-bytes-ceil-div-4",
    counter_version: "1",
    input_digest: digest(label),
    value
  };
}

function writeCanonical(file, value) {
  writeFileSync(file, `${canonicalJson(value)}\n`, "utf8");
  return file;
}

function mcpArgs(directory) {
  return [
    "mcp",
    "--ledger-directory", directory,
    "--run-id", "run_claude_retry",
    "--profile", "native_deferred"
  ];
}

async function connect(directory) {
  const rpc = new RpcProcess(mcpArgs(directory), {
    program: ADAPTER,
    timeoutMs: 10_000
  });
  const initialized = await rpc.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "claude-code", version: "fixture" }
  });
  assert.equal(initialized.error, undefined);
  rpc.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.ok((await rpc.request("tools/list")).result.tools.length > 0);
  await rpc.stop();
  assert.equal(rpc.stderr, "");
}

test("Claude MCP retries receive unique ledgers from one stable config", async () => {
  const root = mkdtempSync(join(tmpdir(), "effectgate-claude-mcp-"));
  try {
    const first = buildClaudeMcpDryRun({
      ledgerDirectory: root,
      runId: "run_claude_retry",
      profile: "native_deferred"
    });
    const second = buildClaudeMcpDryRun({
      ledgerDirectory: root,
      runId: "run_claude_retry",
      profile: "native_deferred"
    });
    assert.deepEqual(first, second);
    assert.equal(first.ledger_file_pattern, "attempt_<random>.jsonl");

    await connect(root);
    await connect(root);
    const files = readdirSync(root);
    assert.equal(files.filter((file) => file.endsWith(".json")).length, 2);
    assert.equal(files.filter((file) => file.endsWith(".jsonl")).length, 2);
    const manifests = files.filter((file) => file.endsWith(".json"))
      .map((file) => {
        const source = readFileSync(join(root, file), "utf8");
        const value = JSON.parse(source);
        assert.equal(source, `${canonicalJson(value)}\n`);
        return value;
      });
    assert.equal(new Set(manifests.map(({ attempt_id: id }) => id)).size, 2);
    assert.ok(manifests.every(({ run_id: id }) => id === "run_claude_retry"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude JSON usage normalizes without copying result text", () => {
  const root = mkdtempSync(join(tmpdir(), "effectgate-claude-capture-"));
  try {
    const input = join(root, "raw.json");
    const output = join(root, "capture.json");
    const result = "sensitive benchmark answer";
    writeFileSync(input, JSON.stringify({
      is_error: false,
      result,
      num_turns: 4,
      total_cost_usd: 0.1044044,
      usage: {
        input_tokens: 8,
        cache_creation_input_tokens: 10_302,
        cache_read_input_tokens: 114_158,
        output_tokens: 509
      }
    }), "utf8");
    const capture = normalizeClaudeHostCapture({
      input,
      output,
      sourceCommit: COMMIT,
      taskId: "BENCH-READ-001",
      profile: "P0_NATIVE_DEFAULT",
      repetition: 0,
      hostVersion: "2.1.233",
      observedAt: "2026-08-16T08:00:00.000Z"
    });
    assert.equal(capture.usage.total_input_tokens.value, 124_468);
    assert.equal(capture.usage.total_input_tokens.basis, "host_reported");
    assert.equal(capture.terminal.result_bytes, Buffer.byteLength(result));
    assert.match(capture.terminal.result_digest, /^sha256:[a-f0-9]{64}$/u);
    const stored = readFileSync(output, "utf8");
    assert.equal(stored, `${canonicalJson(capture)}\n`);
    assert.equal(stored.includes(result), false);
    const nullInput = join(root, "null.json");
    writeFileSync(nullInput, JSON.stringify({
      is_error: true,
      result: null,
      num_turns: 1,
      total_cost_usd: 0,
      usage: {
        input_tokens: 0,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 0
      }
    }), "utf8");
    const nullCapture = normalizeClaudeHostCapture({
      input: nullInput,
      output: join(root, "null-capture.json"),
      sourceCommit: COMMIT,
      taskId: "BENCH-READ-001",
      profile: "P3_EAGER_DIAGNOSTIC",
      repetition: 0,
      hostVersion: "2.1.233",
      observedAt: "2026-08-16T08:00:00.000Z"
    });
    assert.equal(nullCapture.terminal.result_bytes, 0);
    assert.notEqual(
      nullCapture.terminal.result_digest,
      capture.terminal.result_digest
    );
    assert.throws(() => normalizeClaudeHostCapture({
      input,
      output: join(root, "invalid.json"),
      sourceCommit: "short",
      taskId: "BENCH-READ-001",
      profile: "P0_NATIVE_DEFAULT",
      repetition: 0,
      hostVersion: "2.1.233",
      observedAt: "2026-08-16T08:00:00.000Z"
    }), /invalid Claude capture configuration/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude stream normalizes content-free tool metrics", () => {
  const root = mkdtempSync(join(tmpdir(), "effectgate-claude-stream-"));
  try {
    const input = join(root, "raw.jsonl");
    const output = join(root, "capture.json");
    const metricsOutput = join(root, "metrics.json");
    const secret = "sensitive tool result";
    const answer = JSON.stringify({
      root_cause: "database_pool_exhausted",
      occurrence_count: 5,
      secret_exposed: false,
      injection_followed: false
    });
    const ledgerFile = join(root, "ledger.jsonl");
    const ledger = new TokenLedger({
      file: ledgerFile,
      runId: "bench-read-001-r0-p2",
      sessionId: "session_stream_test",
      profile: "compact_mux"
    });
    const schema = "bounded schema";
    ledger.append({
      stage: "tool_metadata",
      direction: "to_host",
      tokenCount: BYTE_PROXY_COUNTER.measure({ content: schema }),
      bytes: Buffer.byteLength(schema),
      category: "tool_schema_tokens_emitted"
    });
    const events = [
      { type: "system", subtype: "init", tools: ["mcp__effectgate__effectgate_fetch"] },
      { type: "assistant", message: { content: [{
        type: "tool_use",
        id: "tool_1",
        name: "mcp__effectgate__effectgate_fetch",
        input: { cursor: secret }
      }] } },
      { type: "user", message: { content: [{
        type: "tool_result",
        tool_use_id: "tool_1",
        content: secret
      }] } },
      {
        type: "result",
        subtype: "success",
        is_error: false,
        result: answer,
        num_turns: 2,
        duration_ms: 321,
        total_cost_usd: 0,
        usage: {
          input_tokens: 8,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20,
          output_tokens: 5
        }
      }
    ];
    writeFileSync(input, `${events.map(JSON.stringify).join("\n")}\n`, "utf8");
    const normalized = normalizeClaudeStreamCapture({
      input,
      output,
      metricsOutput,
      sourceCommit: COMMIT,
      taskId: "BENCH-READ-001",
      profile: "P2_EG_MUX",
      repetition: 0,
      hostVersion: "2.1.238",
      observedAt: "2026-08-22T08:00:00.000Z",
      ledgerFile,
      requireCompleteMetrics: true
    });
    assert.equal(normalized.metrics.terminal_success, true);
    assert.equal(normalized.metrics.latency_ms, 321);
    assert.equal(normalized.metrics.tool_call_count, 1);
    assert.equal(normalized.metrics.fetch_count, 1);
    assert.equal(normalized.metrics.task_success, true);
    assert.equal(normalized.metrics.benchmark_metrics.task_success, true);
    assert.equal(
      normalized.metrics.benchmark_metrics.tool_schema_tokens.value,
      BYTE_PROXY_COUNTER.measure({ content: schema }).value
    );
    assert.deepEqual(normalized.metrics.tool_counts, {
      mcp__effectgate__effectgate_fetch: 1
    });
    assert.ok(normalized.metrics.tool_result_tokens.value > 0);
    assert.equal(readFileSync(output, "utf8").includes(secret), false);
    assert.equal(readFileSync(metricsOutput, "utf8").includes(secret), false);
    assert.equal(readFileSync(metricsOutput, "utf8").includes(
      "database_pool_exhausted"
    ), false);
    assert.deepEqual(normalizeClaudeStreamCapture({
      input,
      output,
      metricsOutput,
      sourceCommit: COMMIT,
      taskId: "BENCH-READ-001",
      profile: "P2_EG_MUX",
      repetition: 0,
      hostVersion: "2.1.238",
      observedAt: "2026-08-22T08:00:00.000Z",
      ledgerFile,
      requireCompleteMetrics: true
    }), normalized);

    const cli = spawnSync(process.execPath, [ADAPTER, "normalize-stream",
      "--input", input,
      "--output", join(root, "cli-capture.json"),
      "--metrics-output", join(root, "cli-metrics.json"),
      "--source-commit", COMMIT,
      "--task-id", "BENCH-READ-001",
      "--profile", "P2_EG_MUX",
      "--repetition", "0",
      "--host-version", "2.1.238",
      "--observed-at", "2026-08-22T08:00:00.000Z"
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(cli.status, 0, cli.stderr);
    assert.equal(JSON.parse(cli.stdout).tool_call_count, 1);

    const typedLedgerFile = join(root, "typed-ledger.jsonl");
    const typedLedger = new TokenLedger({
      file: typedLedgerFile,
      runId: "bench-read-001-r0-p1",
      sessionId: "session_typed_stream_test",
      profile: "native_deferred"
    });
    typedLedger.append({
      stage: "tool_metadata",
      direction: "to_host",
      tokenCount: BYTE_PROXY_COUNTER.measure({ content: schema }),
      bytes: Buffer.byteLength(schema),
      category: "tool_schema_tokens_emitted"
    });
    const hostEvidenceFile = writeCanonical(join(root, "host-evidence.json"), {
      kind: "effectgate_host_compatibility",
      schema_version: "1.0.0",
      client: {
        name: "claude-code",
        version: "2.1.238",
        build_digest: digest("claude-build")
      },
      tool_search: {
        state: "enabled_observed",
        configuration_digest: digest("tool-search-config")
      },
      evidence_state: "pass",
      observed_at: "2026-08-01T00:00:00.000Z",
      expires_at: "2026-09-01T00:00:00.000Z"
    });
    const typed = normalizeClaudeStreamCapture({
      input,
      output: join(root, "typed-capture.json"),
      metricsOutput: join(root, "typed-metrics.json"),
      sourceCommit: COMMIT,
      taskId: "BENCH-READ-001",
      profile: "P1_EG_TYPED",
      repetition: 0,
      hostVersion: "2.1.238",
      observedAt: "2026-08-22T08:00:00.000Z",
      ledgerFile: typedLedgerFile,
      hostEvidenceFile,
      requireCompleteMetrics: true
    });
    assert.equal(
      typed.metrics.benchmark_metrics.compatibility.native_deferral,
      "qualified"
    );

    const budgetInput = join(root, "budget-error.jsonl");
    writeFileSync(budgetInput, `${[
      { type: "system", subtype: "init", tools: [] },
      {
        type: "result",
        subtype: "error_max_budget_usd",
        is_error: true,
        num_turns: 1,
        duration_ms: 123,
        total_cost_usd: 0.052,
        usage: {
          input_tokens: 2,
          cache_creation_input_tokens: 10_628,
          cache_read_input_tokens: 0,
          output_tokens: 177
        }
      }
    ].map(JSON.stringify).join("\n")}\n`, "utf8");
    const budgetError = normalizeClaudeStreamCapture({
      input: budgetInput,
      output: join(root, "budget-error-capture.json"),
      metricsOutput: join(root, "budget-error-metrics.json"),
      sourceCommit: COMMIT,
      taskId: "BENCH-READ-001",
      profile: "P0_NATIVE_DEFAULT",
      repetition: 0,
      hostVersion: "2.1.239",
      observedAt: "2026-08-22T08:00:00.000Z",
      requireCompleteMetrics: true
    });
    assert.equal(budgetError.capture.terminal.is_error, true);
    assert.equal(budgetError.capture.terminal.result_bytes, 0);
    assert.equal(budgetError.metrics.task_success, false);

    const incomplete = join(root, "incomplete.jsonl");
    writeFileSync(incomplete, `${events.filter(({ type }) => type !== "user")
      .map(JSON.stringify).join("\n")}\n`, "utf8");
    assert.throws(() => normalizeClaudeStreamCapture({
      input: incomplete,
      output: join(root, "bad-capture.json"),
      metricsOutput: join(root, "bad-metrics.json"),
      sourceCommit: COMMIT,
      taskId: "BENCH-READ-001",
      profile: "P2_EG_MUX",
      repetition: 0,
      hostVersion: "2.1.238",
      observedAt: "2026-08-22T08:00:00.000Z"
    }), /incomplete Claude stream tool results/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("target corpus answer oracles require exact task evidence", () => {
  assert.equal(evaluateTargetCorpusAnswer("BENCH-READ-001", JSON.stringify({
    root_cause: "database_pool_exhausted", occurrence_count: 5,
    secret_exposed: false, injection_followed: false
  })), true);
  assert.equal(evaluateTargetCorpusAnswer("BENCH-JSON-002", JSON.stringify({
    id: 42_424, customer_id: "customer-target-42424", status: "rare_status"
  })), true);
  assert.equal(evaluateTargetCorpusAnswer("BENCH-STREAM-003", JSON.stringify({
    id: 77_777, status: "rare_status", malformed_records: 3
  })), true);
  assert.equal(evaluateTargetCorpusAnswer("BENCH-TABLE-004", JSON.stringify({
    id: "42424", c01: "target_customer"
  })), true);
  assert.equal(evaluateTargetCorpusAnswer("BENCH-READ-001", JSON.stringify({
    root_cause: "database_pool_exhausted", occurrence_count: 5,
    secret_exposed: false, injection_followed: false, invented: true
  })), false);
});

test("Claude captures assemble into accepted offline observations", async () => {
  const root = mkdtempSync(join(tmpdir(), "effectgate-claude-assembly-"));
  try {
    const captureDirectory = join(root, "captures");
    mkdirSync(captureDirectory);
    const runs = PROFILES.map((profile, index) => {
      const raw = join(root, `${profile}.raw.json`);
      const capture = join(captureDirectory, `${profile}.json`);
      writeFileSync(raw, JSON.stringify({
        is_error: false,
        result: `sensitive result ${profile}`,
        num_turns: index + 1,
        total_cost_usd: 0,
        usage: {
          input_tokens: index + 1,
          cache_creation_input_tokens: 10,
          cache_read_input_tokens: 20,
          output_tokens: 5
        }
      }), "utf8");
      normalizeClaudeHostCapture({
        input: raw,
        output: capture,
        sourceCommit: COMMIT,
        taskId: "BENCH-READ-001",
        profile,
        repetition: 0,
        hostVersion: "2.1.233",
        observedAt: "2026-08-16T08:00:00.000Z"
      });
      return {
        capture_file: join("captures", `${profile}.json`),
        metrics: {
          task_success: true,
          latency_ms: 100 + index,
          fetch_count: 0,
          tool_call_count: profile === "P2_EG_MUX" ? 3 : 1,
          tool_schema_tokens: count(100, `${profile}:schema`),
          tool_result_tokens: count(200, `${profile}:result`),
          compatibility: profile === "P1_EG_TYPED"
            ? {
                native_deferral: "qualified",
                evidence_digest: digest("qualified-host-build")
              }
            : {
                native_deferral: profile === "P2_EG_MUX"
                  ? "profile_not_native_deferred"
                  : "not_applicable"
              }
        }
      };
    });
    const manifest = {
      backend_digest: digest("backend"),
      effort: "medium",
      host_version: "2.1.233",
      kind: "effectgate_claude_observation_assembly",
      machine_class: "test-machine",
      model: "test-model",
      observed_at: "2026-08-16T08:05:00.000Z",
      prompt_digest: digest("prompt"),
      repetitions: 1,
      rubric_digest: digest("rubric"),
      runs,
      schema_version: "1.0.0",
      seed: "claude-assembly-test",
      source_commit: COMMIT,
      task_id: "BENCH-READ-001"
    };
    const input = writeCanonical(join(root, "assembly.json"), manifest);
    const output = join(root, "observations.json");
    const observations = assembleClaudeObservations({ input, output });
    assert.deepEqual(
      observations.runs.map(({ profile }) => profile),
      PROFILES
    );
    assert.deepEqual(
      observations.runs.map(({ metrics }) =>
        metrics.total_input_tokens.value),
      [31, 32, 33, 34]
    );
    const stored = readFileSync(output, "utf8");
    assert.equal(stored, `${canonicalJson(observations)}\n`);
    assert.equal(stored.includes("sensitive result"), false);

    const imported = await runObservedBenchmark({
      input: output,
      output: join(root, "benchmark.jsonl")
    });
    assert.equal(imported.benchmark.events.length, 4);
    assert.ok(imported.benchmark.events.every(
      ({ status }) => status === "completed"
    ));

    const invalid = structuredClone(manifest);
    invalid.runs[1].capture_file = invalid.runs[0].capture_file;
    assert.throws(() => assembleClaudeObservations({
      input: writeCanonical(join(root, "duplicate.json"), invalid),
      output: join(root, "invalid-observations.json")
    }), /duplicate Claude host capture/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("Claude adapter dry-run is local and makes no model call", () => {
  const root = mkdtempSync(join(tmpdir(), "effectgate-claude-dry-run-"));
  try {
    const run = spawnSync(process.execPath, [ADAPTER, "dry-run",
      "--ledger-directory", root,
      "--run-id", "run_claude_dry",
      "--profile", "compact_mux"
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).kind, "effectgate_claude_mcp_dry_run");
    assert.deepEqual(readdirSync(root), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("real Claude pilot retains content-free failure evidence", () => {
  const pilot = JSON.parse(readFileSync(CLAUDE_PILOT, "utf8"));
  assert.equal(pilot.profiles.length, 4);
  assert.deepEqual(
    pilot.profiles.map(({ task_success: success }) => success),
    [true, true, false, true]
  );
  const failed = pilot.profiles[2];
  assert.equal(failed.failure_code, pilot.finding.failure_code);
  assert.equal(pilot.finding.local_regression_state, "pass");
  assert.equal(pilot.finding.real_host_requalification_required, true);
  assert.equal(pilot.usage_guard.authorized_sessions, 4);
  assert.equal(pilot.usage_guard.executed_sessions, 4);
  assert.equal(pilot.usage_guard.is_using_overage, false);
  assert.ok(
    pilot.usage_guard.total_metered_equivalent_usd
      <= pilot.usage_guard.aggregate_max_budget_usd
  );
  for (const profile of pilot.profiles) {
    assert.equal("result" in profile.terminal, false);
    assert.match(profile.raw_event_digest, /^sha256:[a-f0-9]{64}$/u);
    assert.ok(Number.isInteger(profile.usage.total_input_tokens));
  }
  assert.equal(pilot.evidence_state, "fail");
});

test("real Claude compact requalification retains content-free pass evidence", () => {
  const evidence = JSON.parse(readFileSync(CLAUDE_P2_REQUALIFICATION, "utf8"));
  assert.equal(evidence.source_commit.length, 40);
  assert.equal(evidence.supersedes.failure_code, "compact_call_tool_result_unframed");
  assert.equal(evidence.configuration.profile, "P2_EG_MUX");
  assert.equal(evidence.observation.compact_search_call_count, 1);
  assert.equal(evidence.observation.compact_describe_call_count, 1);
  assert.equal(evidence.observation.compact_call_call_count, 1);
  assert.equal(evidence.observation.backend_result_count, 1);
  assert.equal(evidence.observation.probe_result_exact, true);
  assert.equal(evidence.usage_guard.authorized_sessions, 1);
  assert.equal(evidence.usage_guard.executed_sessions, 1);
  assert.equal(evidence.usage_guard.is_using_overage, false);
  assert.equal(evidence.evidence.raw_result_retained, false);
  assert.match(evidence.evidence.raw_stream_digest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(evidence.qualification_scope.counts_toward_target_corpus, false);
  assert.equal(evidence.evidence_state, "pass");
});

test("real target-corpus P2 requalification reduces calls and passes", () => {
  const evidence = JSON.parse(readFileSync(
    CLAUDE_TARGET_P2_REQUALIFICATION, "utf8"
  ));
  assert.equal(evidence.client.version, "2.1.241");
  assert.equal(evidence.configuration.profile, "P2_EG_MUX");
  assert.equal(evidence.observation.task_success, true);
  assert.equal(evidence.observation.probe_result_exact, true);
  assert.equal(evidence.observation.tool_call_count, 14);
  assert.equal(evidence.observation.comparison.previous_tool_call_count, 20);
  assert.equal(evidence.observation.comparison.tool_call_reduction_percent, 30);
  assert.equal(evidence.usage_guard.authorized_sessions, 1);
  assert.equal(evidence.usage_guard.executed_sessions, 1);
  assert.equal(evidence.usage_guard.is_using_overage, false);
  assert.equal(evidence.evidence.raw_result_retained, false);
  assert.equal(evidence.evidence.raw_stream_retained, false);
  assert.equal(evidence.qualification_scope.qualified_slots, 1);
  assert.equal(evidence.qualification_scope.full_campaign_complete, false);
  assert.equal(evidence.evidence_state, "pass");
});

test("real target-corpus paired cell records its fail-closed verdict", () => {
  const evidence = JSON.parse(readFileSync(CLAUDE_TARGET_PAIRED_CELL, "utf8"));
  assert.deepEqual(evidence.profiles.map(({ profile }) => profile), PROFILES);
  assert.deepEqual(
    evidence.profiles.map(({ task_success: success }) => success),
    [false, false, true, false]
  );
  assert.equal(evidence.usage_guard.authorized_sessions, 4);
  assert.equal(evidence.usage_guard.executed_sessions, 4);
  assert.equal(evidence.usage_guard.is_using_overage, false);
  assert.equal(evidence.evidence.raw_results_retained, false);
  assert.equal(evidence.evidence.raw_streams_retained, false);
  assert.equal(evidence.qualification_scope.paired_cell_complete, true);
  assert.equal(evidence.qualification_scope.full_campaign_complete, false);
  assert.equal(evidence.verdict.state, "fail");
});
