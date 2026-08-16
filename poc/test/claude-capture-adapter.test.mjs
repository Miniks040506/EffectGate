import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
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
  buildClaudeMcpDryRun,
  normalizeClaudeHostCapture
} from "../src/benchmark/claude-capture-adapter.mjs";
import { canonicalJson } from "../src/skill/passport-compiler.mjs";
import { MCP_VERSION } from "../src/proxy/effectgate.mjs";
import { RpcProcess } from "../src/testkit/rpc-process.mjs";

const ADAPTER = fileURLToPath(new URL(
  "../src/benchmark/claude-capture-adapter.mjs", import.meta.url
));
const COMMIT = "a".repeat(40);

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
