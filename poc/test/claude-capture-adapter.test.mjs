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
  normalizeClaudeHostCapture
} from "../src/benchmark/claude-capture-adapter.mjs";
import { runObservedBenchmark } from "../src/benchmark/observation-runner.mjs";
import { canonicalJson } from "../src/skill/passport-compiler.mjs";
import { MCP_VERSION } from "../src/proxy/effectgate.mjs";
import { RpcProcess } from "../src/testkit/rpc-process.mjs";

const ADAPTER = fileURLToPath(new URL(
  "../src/benchmark/claude-capture-adapter.mjs", import.meta.url
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
