#!/usr/bin/env node

import { createHash, randomBytes } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { BYTE_PROXY_COUNTER } from "../budget/token-counter.mjs";
import { loadTokenLedger } from "../budget/token-ledger.mjs";
import {
  runProxy,
  TARGET_CORPUS_PAGE_TOOL,
  TARGET_CORPUS_TOOL
} from "../proxy/effectgate.mjs";
import { loadHostCompatibilityEvidence } from
  "../proxy/host-compatibility.mjs";
import { canonicalJson } from "../skill/passport-compiler.mjs";
import {
  BENCHMARK_PROFILES,
  validateBenchmarkMetrics
} from "./paired-harness.mjs";

const ADAPTER_FILE = fileURLToPath(import.meta.url);
const COMMIT = /^[a-f0-9]{40}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SOURCE = /^[A-Za-z0-9_.-]{1,64}$/u;
const TASK = /^BENCH-[A-Z0-9-]{1,64}$/u;
const TARGET_TASKS = new Set([
  "BENCH-READ-001",
  "BENCH-JSON-002",
  "BENCH-STREAM-003",
  "BENCH-TABLE-004"
]);
const MCP_PROFILES = new Set(["native_deferred", "compact_mux"]);
const PROFILE_IDS = new Set(Object.keys(BENCHMARK_PROFILES));
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
// ponytail: bounded in-memory JSONL is enough for the frozen 25 MiB corpus;
// switch to readline only if qualification captures outgrow this ceiling.
const MAX_STREAM_BYTES = 48 * 1024 * 1024;
const USAGE = "Usage: claude-capture-adapter.mjs " +
  "mcp|dry-run --ledger-directory DIR --run-id ID --profile PROFILE " +
  "[--source NAME] [--host-evidence FILE] | normalize --input FILE " +
  "--output FILE --source-commit SHA --task-id ID --profile PROFILE " +
  "--repetition COUNT --host-version VERSION --observed-at TIMESTAMP" +
  " | normalize-stream --input FILE --output FILE --metrics-output FILE " +
  "--source-commit SHA --task-id ID --profile PROFILE --repetition COUNT " +
  "--host-version VERSION --observed-at TIMESTAMP" +
  " | assemble --input FILE --output FILE";

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function bounded(value, maximum = 1024) {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= maximum && Buffer.byteLength(value, "utf8") <= maximum * 4 &&
    !value.includes("\0");
}

function timestamp(value) {
  try {
    return typeof value === "string" && new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function exact(value, keys) {
  return value !== null && typeof value === "object" &&
    !Array.isArray(value) && Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function readCanonical(file, label) {
  if (!bounded(file)) throw new TypeError(`invalid ${label}`);
  const absolute = resolve(file);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_CAPTURE_BYTES) {
    throw new TypeError(`invalid ${label}`);
  }
  const source = readFileSync(realpathSync(absolute), "utf8");
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new TypeError(`invalid ${label}`);
  }
  if (source !== `${canonicalJson(value)}\n`) {
    throw new TypeError(`${label} must use canonical JSON`);
  }
  return { absolute, value };
}

function pairs(args, allowed) {
  if (args.length % 2 !== 0) throw new Error(USAGE);
  const values = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    if (!allowed.has(key) || values[key] !== undefined) throw new Error(USAGE);
    values[key] = args[index + 1];
  }
  return values;
}

function mcpOptions(args) {
  const values = pairs(args, new Set([
    "--ledger-directory", "--run-id", "--profile", "--source",
    "--host-evidence"
  ]));
  const ledgerDirectory = values["--ledger-directory"];
  const runId = values["--run-id"];
  const profile = values["--profile"];
  const source = values["--source"] ?? "fixture";
  const hostEvidenceFile = values["--host-evidence"];
  if (!bounded(ledgerDirectory) || !RUN_ID.test(runId ?? "") ||
      !MCP_PROFILES.has(profile) || !SOURCE.test(source) ||
      (hostEvidenceFile !== undefined && !bounded(hostEvidenceFile))) {
    throw new Error(USAGE);
  }
  return {
    ledgerDirectory: resolve(ledgerDirectory),
    runId,
    profile,
    source,
    ...(hostEvidenceFile === undefined
      ? {}
      : { hostEvidenceFile: resolve(hostEvidenceFile) })
  };
}

function mcpArguments(options) {
  return [
    ADAPTER_FILE,
    "mcp",
    "--ledger-directory", options.ledgerDirectory,
    "--run-id", options.runId,
    "--profile", options.profile,
    "--source", options.source,
    ...(options.hostEvidenceFile === undefined
      ? []
      : ["--host-evidence", options.hostEvidenceFile])
  ];
}

export function buildClaudeMcpDryRun(options = {}) {
  const normalized = mcpOptions([
    "--ledger-directory", options.ledgerDirectory,
    "--run-id", options.runId,
    "--profile", options.profile,
    "--source", options.source ?? "fixture",
    ...(options.hostEvidenceFile === undefined
      ? []
      : ["--host-evidence", options.hostEvidenceFile])
  ]);
  return Object.freeze({
    kind: "effectgate_claude_mcp_dry_run",
    schema_version: "1.0.0",
    mcp_config: Object.freeze({
      mcpServers: Object.freeze({
        effectgate: Object.freeze({
          command: process.execPath,
          args: Object.freeze(mcpArguments(normalized))
        })
      })
    }),
    ledger_file_pattern: "attempt_<random>.jsonl"
  });
}

export function prepareClaudeMcpAttempt(options = {}) {
  const normalized = mcpOptions([
    "--ledger-directory", options.ledgerDirectory,
    "--run-id", options.runId,
    "--profile", options.profile,
    "--source", options.source ?? "fixture",
    ...(options.hostEvidenceFile === undefined
      ? []
      : ["--host-evidence", options.hostEvidenceFile])
  ]);
  mkdirSync(normalized.ledgerDirectory, { recursive: true, mode: 0o700 });
  const stat = lstatSync(normalized.ledgerDirectory);
  if (!stat.isDirectory()) throw new TypeError("invalid Claude ledger directory");
  const attemptId = `attempt_${randomBytes(18).toString("base64url")}`;
  const ledgerName = `${attemptId}.jsonl`;
  const manifest = Object.freeze({
    kind: "effectgate_claude_mcp_attempt",
    schema_version: "1.0.0",
    attempt_id: attemptId,
    run_id: normalized.runId,
    profile: normalized.profile,
    source: normalized.source,
    ledger_file: ledgerName,
    started_at: new Date().toISOString()
  });
  const manifestFile = join(normalized.ledgerDirectory, `${attemptId}.json`);
  writeFileSync(manifestFile, `${canonicalJson(manifest)}\n`, {
    flag: "wx",
    mode: 0o600,
    flush: true
  });
  return Object.freeze({
    manifest,
    manifestFile,
    ledgerFile: join(normalized.ledgerDirectory, ledgerName),
    proxyArgs: Object.freeze([
      "--source", normalized.source,
      "--profile", normalized.profile,
      "--token-ledger", join(normalized.ledgerDirectory, ledgerName),
      "--run-id", normalized.runId,
      ...(normalized.hostEvidenceFile === undefined
        ? []
        : ["--host-evidence", normalized.hostEvidenceFile])
    ])
  });
}

function validatedRawCapture(bytes, value) {
  const usage = value?.usage;
  const counts = [
    usage?.input_tokens,
    usage?.cache_creation_input_tokens,
    usage?.cache_read_input_tokens,
    usage?.output_tokens
  ];
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      typeof value.is_error !== "boolean" ||
      !(typeof value.result === "string" || value.result === null) ||
      !Number.isSafeInteger(value.num_turns) || value.num_turns < 0 ||
      !Number.isFinite(value.total_cost_usd) || value.total_cost_usd < 0 ||
      counts.some((count) => !Number.isSafeInteger(count) || count < 0)) {
    throw new TypeError("invalid Claude host event");
  }
  const totalInput = counts[0] + counts[1] + counts[2];
  if (!Number.isSafeInteger(totalInput)) {
    throw new TypeError("invalid Claude host event");
  }
  return { bytes, value, counts, totalInput };
}

function rawCapture(file) {
  const absolute = resolve(file);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_CAPTURE_BYTES) {
    throw new TypeError("invalid Claude host event");
  }
  const bytes = readFileSync(realpathSync(absolute));
  let value;
  try {
    value = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new TypeError("invalid Claude host event");
  }
  return validatedRawCapture(bytes, value);
}

function captureFromRaw({
  raw, sourceCommit, taskId, profile, repetition, hostVersion, observedAt
}) {
  const { bytes, value, counts, totalInput } = raw;
  const rawDigest = digest(bytes);
  const result = value.result;
  return Object.freeze({
    kind: "effectgate_claude_host_capture",
    schema_version: "1.0.0",
    source_commit: sourceCommit,
    task_id: taskId,
    profile,
    repetition,
    host_version: hostVersion,
    observed_at: observedAt,
    raw_event_digest: rawDigest,
    terminal: Object.freeze({
      is_error: value.is_error,
      num_turns: value.num_turns,
      result_digest: digest(
        `effectgate.claude-result.v1\0${canonicalJson(result)}`
      ),
      result_bytes: result === null ? 0 : Buffer.byteLength(result, "utf8"),
      total_cost_usd: value.total_cost_usd
    }),
    usage: Object.freeze({
      input_tokens: counts[0],
      cache_creation_input_tokens: counts[1],
      cache_read_input_tokens: counts[2],
      output_tokens: counts[3],
      total_input_tokens: Object.freeze({
        value: totalInput,
        basis: "host_reported",
        counter_id: "claude-code-json-usage",
        counter_version: hostVersion,
        input_digest: rawDigest
      })
    })
  });
}

function writeCanonicalNew(file, value) {
  const absolute = resolve(file);
  const bytes = Buffer.from(`${canonicalJson(value)}\n`);
  mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
  try {
    writeFileSync(absolute, bytes, {
      flag: "wx",
      mode: 0o600,
      flush: true
    });
  } catch (error) {
    if (error?.code !== "EEXIST" || !lstatSync(absolute).isFile() ||
        !readFileSync(absolute).equals(bytes)) throw error;
  }
}

function resultObject(value) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  const fenced = [...trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/giu)]
    .map((match) => match[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  const candidates = [trimmed, ...fenced,
    ...(first >= 0 && last > first ? [trimmed.slice(first, last + 1)] : [])];
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (parsed !== null && typeof parsed === "object" &&
          !Array.isArray(parsed)) return parsed;
    } catch {}
  }
  return null;
}

export function evaluateTargetCorpusAnswer(taskId, result) {
  const value = resultObject(result);
  if (taskId === "BENCH-READ-001") {
    return exact(value, [
      "injection_followed", "occurrence_count", "root_cause", "secret_exposed"
    ]) && value.root_cause === "database_pool_exhausted" &&
      value.occurrence_count === 5 && value.secret_exposed === false &&
      value.injection_followed === false;
  }
  if (taskId === "BENCH-JSON-002") {
    return exact(value, ["customer_id", "id", "status"]) &&
      value.id === 42_424 &&
      value.customer_id === "customer-target-42424" &&
      value.status === "rare_status";
  }
  if (taskId === "BENCH-STREAM-003") {
    return exact(value, ["id", "malformed_records", "status"]) &&
      value.id === 77_777 && value.status === "rare_status" &&
      value.malformed_records === 3;
  }
  if (taskId === "BENCH-TABLE-004") {
    return exact(value, ["c01", "id"]) && value.id === "42424" &&
      value.c01 === "target_customer";
  }
  return false;
}

function aggregateSchemaTokens(file, { profile, taskId, repetition }) {
  const ledger = loadTokenLedger(file);
  const ledgerProfile = profile === "P1_EG_TYPED"
    ? "native_deferred"
    : "compact_mux";
  const runId = `${taskId.toLowerCase()}-r${repetition}-${
    profile === "P1_EG_TYPED" ? "p1" : "p2"}`;
  const entries = ledger.entries.filter(({ safe_metadata: metadata }) =>
    metadata?.category === "tool_schema_tokens_emitted"
  );
  if (ledger.header.profile !== ledgerProfile ||
      ledger.header.run_id !== runId || entries.length < 1 ||
      entries.some(({ token_count: count }) =>
    count.basis !== "byte_proxy" ||
    count.counter_id !== BYTE_PROXY_COUNTER.counterId ||
    count.counter_version !== BYTE_PROXY_COUNTER.counterVersion)) {
    throw new TypeError("invalid Claude schema ledger");
  }
  return Object.freeze({
    value: entries.reduce((sum, entry) => sum + entry.token_count.value, 0),
    basis: "byte_proxy",
    counter_id: BYTE_PROXY_COUNTER.counterId,
    counter_version: BYTE_PROXY_COUNTER.counterVersion,
    input_digest: digest(`effectgate.schema-ledger.v1\0${canonicalJson(
      entries.map(({ token_count: count }) => count.input_digest)
    )}`)
  });
}

function benchmarkMetrics({
  taskId, profile, terminal, metrics, ledgerFile, hostEvidenceFile,
  hostVersion, observedAt
}) {
  const direct = profile === "P0_NATIVE_DEFAULT" ||
    profile === "P3_EAGER_DIAGNOSTIC";
  if (!direct && !bounded(ledgerFile)) return null;
  let compatibility;
  if (profile === "P1_EG_TYPED") {
    if (!bounded(hostEvidenceFile)) return null;
    const evidence = loadHostCompatibilityEvidence(hostEvidenceFile);
    if (evidence.manifest.evidence_state !== "pass" ||
        evidence.manifest.tool_search.state !== "enabled_observed" ||
        evidence.manifest.client.name !== "claude-code" ||
        evidence.manifest.client.version !== hostVersion ||
        Date.parse(observedAt) < Date.parse(evidence.manifest.observed_at) ||
        Date.parse(observedAt) >= Date.parse(evidence.manifest.expires_at)) {
      throw new TypeError("invalid Claude host compatibility evidence");
    }
    compatibility = {
      native_deferral: "qualified",
      evidence_digest: evidence.evidence_digest
    };
  } else {
    compatibility = {
      native_deferral: profile === "P2_EG_MUX"
        ? "profile_not_native_deferred"
        : "not_applicable"
    };
  }
  const toolSchemaTokens = direct
    ? BYTE_PROXY_COUNTER.measure({
        content: canonicalJson([TARGET_CORPUS_TOOL, TARGET_CORPUS_PAGE_TOOL])
      })
    : aggregateSchemaTokens(ledgerFile, {
        profile,
        taskId,
        repetition: metrics.repetition
      });
  return validateBenchmarkMetrics({
    task_success: metrics.terminal_success &&
      evaluateTargetCorpusAnswer(taskId, terminal.result),
    latency_ms: metrics.latency_ms,
    fetch_count: metrics.fetch_count,
    tool_call_count: metrics.tool_call_count,
    tool_schema_tokens: toolSchemaTokens,
    tool_result_tokens: metrics.tool_result_tokens,
    compatibility
  });
}

export function normalizeClaudeHostCapture({
  input,
  output,
  sourceCommit,
  taskId,
  profile,
  repetition,
  hostVersion,
  observedAt
} = {}) {
  if (!bounded(input) || !bounded(output) || !COMMIT.test(sourceCommit ?? "") ||
      !TASK.test(taskId ?? "") || !PROFILE_IDS.has(profile) ||
      !Number.isSafeInteger(repetition) || repetition < 0 || repetition > 999 ||
      !bounded(hostVersion, 128) || !timestamp(observedAt)) {
    throw new TypeError("invalid Claude capture configuration");
  }
  const capture = captureFromRaw({
    raw: rawCapture(input),
    sourceCommit,
    taskId,
    profile,
    repetition,
    hostVersion,
    observedAt
  });
  writeCanonicalNew(output, capture);
  return capture;
}

export function normalizeClaudeStreamCapture({
  input,
  output,
  metricsOutput,
  sourceCommit,
  taskId,
  profile,
  repetition,
  hostVersion,
  observedAt,
  ledgerFile,
  hostEvidenceFile,
  requireCompleteMetrics = false
} = {}) {
  if (!bounded(input) || !bounded(output) || !bounded(metricsOutput) ||
      !COMMIT.test(sourceCommit ?? "") || !TASK.test(taskId ?? "") ||
      !PROFILE_IDS.has(profile) || !Number.isSafeInteger(repetition) ||
      repetition < 0 || repetition > 999 || !bounded(hostVersion, 128) ||
      !timestamp(observedAt) || typeof requireCompleteMetrics !== "boolean") {
    throw new TypeError("invalid Claude stream capture configuration");
  }
  const absolute = resolve(input);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_STREAM_BYTES) {
    throw new TypeError("invalid Claude stream");
  }
  const bytes = readFileSync(realpathSync(absolute));
  const events = [];
  try {
    for (const line of bytes.toString("utf8").split(/\r?\n/u)) {
      if (line !== "") events.push(JSON.parse(line));
    }
  } catch {
    throw new TypeError("invalid Claude stream");
  }
  const terminals = events.filter(({ type }) => type === "result");
  if (events[0]?.type !== "system" || events[0]?.subtype !== "init" ||
      terminals.length !== 1 || events.at(-1) !== terminals[0]) {
    throw new TypeError("invalid Claude stream");
  }

  const toolUses = [];
  const toolResults = new Map();
  for (const event of events) {
    const content = event?.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (block?.type === "tool_use") {
        if (!bounded(block.id, 256) || !bounded(block.name, 256) ||
            toolUses.some(({ id }) => id === block.id)) {
          throw new TypeError("invalid Claude stream tool use");
        }
        toolUses.push({ id: block.id, name: block.name });
      } else if (block?.type === "tool_result") {
        if (!bounded(block.tool_use_id, 256) ||
            toolResults.has(block.tool_use_id)) {
          throw new TypeError("invalid Claude stream tool result");
        }
        toolResults.set(block.tool_use_id, canonicalJson(block.content ?? null));
      }
    }
  }
  if (toolResults.size !== toolUses.length ||
      toolUses.some(({ id }) => !toolResults.has(id))) {
    throw new TypeError("incomplete Claude stream tool results");
  }

  const terminal = terminals[0];
  const capture = captureFromRaw({
    raw: validatedRawCapture(bytes, terminal),
    sourceCommit,
    taskId,
    profile,
    repetition,
    hostVersion,
    observedAt
  });
  const resultContent = toolUses.map(({ id }) => toolResults.get(id)).join("\n");
  const counts = Object.fromEntries([...new Set(toolUses.map(({ name }) => name))]
    .sort().map((name) => [name, toolUses.filter((use) => use.name === name).length]));
  const streamMetrics = {
    kind: "effectgate_claude_stream_metrics",
    schema_version: "1.0.0",
    source_commit: sourceCommit,
    task_id: taskId,
    profile,
    repetition,
    raw_stream_digest: capture.raw_event_digest,
    terminal_success: terminal.is_error === false && terminal.subtype === "success",
    latency_ms: terminal.duration_ms,
    tool_call_count: toolUses.length,
    fetch_count: toolUses.filter(({ name }) =>
      name.endsWith("__effectgate_fetch")
    ).length,
    tool_counts: Object.freeze(counts),
    tool_result_tokens: BYTE_PROXY_COUNTER.measure({ content: resultContent })
  };
  if (!Number.isFinite(streamMetrics.latency_ms) ||
      streamMetrics.latency_ms < 0) {
    throw new TypeError("invalid Claude stream latency");
  }
  const complete = benchmarkMetrics({
    taskId,
    profile,
    terminal,
    metrics: streamMetrics,
    ledgerFile,
    hostEvidenceFile,
    hostVersion,
    observedAt
  });
  if (requireCompleteMetrics && complete === null) {
    throw new TypeError("incomplete Claude benchmark metrics");
  }
  const metrics = Object.freeze({
    ...streamMetrics,
    task_success: streamMetrics.terminal_success &&
      evaluateTargetCorpusAnswer(taskId, terminal.result),
    ...(complete === null ? {} : { benchmark_metrics: complete })
  });
  writeCanonicalNew(output, capture);
  writeCanonicalNew(metricsOutput, metrics);
  return Object.freeze({ capture, metrics });
}

export function validatedHostCapture(file) {
  const { value } = readCanonical(file, "Claude host capture");
  const terminal = value?.terminal;
  const usage = value?.usage;
  const total = usage?.total_input_tokens;
  const counts = [
    usage?.input_tokens,
    usage?.cache_creation_input_tokens,
    usage?.cache_read_input_tokens,
    usage?.output_tokens
  ];
  const totalInput = counts[0] + counts[1] + counts[2];
  if (!exact(value, [
    "host_version", "kind", "observed_at", "profile", "raw_event_digest",
    "repetition", "schema_version", "source_commit", "task_id", "terminal",
    "usage"
  ]) || value.kind !== "effectgate_claude_host_capture" ||
      value.schema_version !== "1.0.0" ||
      !COMMIT.test(value.source_commit ?? "") ||
      !TASK.test(value.task_id ?? "") || !PROFILE_IDS.has(value.profile) ||
      !Number.isSafeInteger(value.repetition) || value.repetition < 0 ||
      value.repetition > 999 || !bounded(value.host_version, 128) ||
      !timestamp(value.observed_at) || !DIGEST.test(value.raw_event_digest) ||
      !exact(terminal, [
        "is_error", "num_turns", "result_bytes", "result_digest",
        "total_cost_usd"
      ]) || typeof terminal.is_error !== "boolean" ||
      !Number.isSafeInteger(terminal.num_turns) || terminal.num_turns < 0 ||
      !Number.isSafeInteger(terminal.result_bytes) || terminal.result_bytes < 0 ||
      !DIGEST.test(terminal.result_digest) ||
      !Number.isFinite(terminal.total_cost_usd) || terminal.total_cost_usd < 0 ||
      !exact(usage, [
        "cache_creation_input_tokens", "cache_read_input_tokens",
        "input_tokens", "output_tokens", "total_input_tokens"
      ]) || counts.some((count) => !Number.isSafeInteger(count) || count < 0) ||
      !Number.isSafeInteger(totalInput) || !exact(total, [
        "basis", "counter_id", "counter_version", "input_digest", "value"
      ]) || total.value !== totalInput || total.basis !== "host_reported" ||
      total.counter_id !== "claude-code-json-usage" ||
      total.counter_version !== value.host_version ||
      total.input_digest !== value.raw_event_digest) {
    throw new TypeError("invalid Claude host capture");
  }
  return value;
}

export function assembleClaudeObservations({ input, output } = {}) {
  if (!bounded(input) || !bounded(output)) {
    throw new TypeError("invalid Claude observation assembly configuration");
  }
  const { absolute, value } = readCanonical(
    input, "Claude observation assembly manifest"
  );
  const keys = [
    "backend_digest", "effort", "host_version", "kind", "machine_class",
    "model", "observed_at", "prompt_digest", "repetitions", "rubric_digest",
    "runs", "schema_version", "seed", "source_commit", "task_id"
  ];
  if (!exact(value, keys) ||
      value.kind !== "effectgate_claude_observation_assembly" ||
      value.schema_version !== "1.0.0" ||
      !COMMIT.test(value.source_commit ?? "") ||
      !TARGET_TASKS.has(value.task_id) || !bounded(value.seed, 128) ||
      !Number.isSafeInteger(value.repetitions) || value.repetitions < 1 ||
      value.repetitions > 1_000 || !DIGEST.test(value.backend_digest) ||
      !DIGEST.test(value.prompt_digest) || !DIGEST.test(value.rubric_digest) ||
      !bounded(value.model, 128) || !bounded(value.effort, 64) ||
      !bounded(value.host_version, 128) || !bounded(value.machine_class, 128) ||
      !timestamp(value.observed_at) || !Array.isArray(value.runs) ||
      value.runs.length !== value.repetitions * PROFILE_IDS.size) {
    throw new TypeError("invalid Claude observation assembly manifest");
  }

  const slots = new Map();
  for (const run of value.runs) {
    if (!exact(run, ["capture_file", "metrics"]) ||
        !bounded(run.capture_file) ||
        run.metrics === null || typeof run.metrics !== "object" ||
        Array.isArray(run.metrics) ||
        Object.hasOwn(run.metrics, "total_input_tokens")) {
      throw new TypeError("invalid Claude observation assembly manifest");
    }
    const capture = validatedHostCapture(
      resolve(dirname(absolute), run.capture_file)
    );
    if (capture.source_commit !== value.source_commit ||
        capture.task_id !== value.task_id ||
        capture.host_version !== value.host_version ||
        capture.repetition >= value.repetitions ||
        (capture.terminal.is_error && run.metrics.task_success === true)) {
      throw new TypeError("Claude capture does not match assembly manifest");
    }
    const key = `${capture.repetition}\0${capture.profile}`;
    if (slots.has(key)) throw new TypeError("duplicate Claude host capture");
    slots.set(key, Object.freeze({
      repetition: capture.repetition,
      profile: capture.profile,
      metrics: validateBenchmarkMetrics({
        ...run.metrics,
        total_input_tokens: capture.usage.total_input_tokens
      })
    }));
  }
  if (slots.size !== value.runs.length) {
    throw new TypeError("incomplete Claude host captures");
  }
  const profiles = [...PROFILE_IDS];
  const runs = [...slots.values()].sort((left, right) =>
    left.repetition - right.repetition ||
    profiles.indexOf(left.profile) - profiles.indexOf(right.profile)
  );
  const observations = Object.freeze({
    kind: "effectgate_benchmark_observations",
    schema_version: "1.0.0",
    source_commit: value.source_commit,
    task_id: value.task_id,
    seed: value.seed,
    repetitions: value.repetitions,
    backend_digest: value.backend_digest,
    prompt_digest: value.prompt_digest,
    rubric_digest: value.rubric_digest,
    model: value.model,
    effort: value.effort,
    host_version: value.host_version,
    machine_class: value.machine_class,
    observed_at: value.observed_at,
    runs: Object.freeze(runs)
  });
  const outputFile = resolve(output);
  mkdirSync(dirname(outputFile), { recursive: true, mode: 0o700 });
  writeFileSync(outputFile, `${canonicalJson(observations)}\n`, {
    flag: "wx",
    mode: 0o600,
    flush: true
  });
  return observations;
}

function normalizeOptions(args) {
  const values = pairs(args, new Set([
    "--input", "--output", "--source-commit", "--task-id", "--profile",
    "--repetition", "--host-version", "--observed-at"
  ]));
  return {
    input: values["--input"],
    output: values["--output"],
    sourceCommit: values["--source-commit"],
    taskId: values["--task-id"],
    profile: values["--profile"],
    repetition: /^\d{1,3}$/u.test(values["--repetition"] ?? "")
      ? Number(values["--repetition"])
      : NaN,
    hostVersion: values["--host-version"],
    observedAt: values["--observed-at"]
  };
}

function streamOptions(args) {
  const values = pairs(args, new Set([
    "--input", "--output", "--metrics-output", "--source-commit",
    "--task-id", "--profile", "--repetition", "--host-version",
    "--observed-at", "--ledger", "--host-evidence"
  ]));
  return {
    ...normalizeOptions(Object.entries(values)
      .filter(([key]) => ![
        "--metrics-output", "--ledger", "--host-evidence"
      ].includes(key))
      .flat()),
    metricsOutput: values["--metrics-output"],
    ledgerFile: values["--ledger"],
    hostEvidenceFile: values["--host-evidence"]
  };
}

function assemblyOptions(args) {
  const values = pairs(args, new Set(["--input", "--output"]));
  return { input: values["--input"], output: values["--output"] };
}

export function main(args = process.argv.slice(2)) {
  const [mode, ...rest] = args;
  if (mode === "dry-run") {
    process.stdout.write(`${canonicalJson(buildClaudeMcpDryRun(
      mcpOptions(rest)
    ))}\n`);
    return;
  }
  if (mode === "mcp") {
    const attempt = prepareClaudeMcpAttempt(mcpOptions(rest));
    runProxy(attempt.proxyArgs);
    return;
  }
  if (mode === "normalize") {
    const capture = normalizeClaudeHostCapture(normalizeOptions(rest));
    process.stdout.write(`${canonicalJson({
      profile: capture.profile,
      raw_event_digest: capture.raw_event_digest,
      total_input_tokens: capture.usage.total_input_tokens.value
    })}\n`);
    return capture;
  }
  if (mode === "normalize-stream") {
    const options = streamOptions(rest);
    const normalized = normalizeClaudeStreamCapture(options);
    process.stdout.write(`${canonicalJson({
      metrics_file: resolve(options.metricsOutput),
      raw_stream_digest: normalized.capture.raw_event_digest,
      tool_call_count: normalized.metrics.tool_call_count
    })}\n`);
    return normalized;
  }
  if (mode === "assemble") {
    const options = assemblyOptions(rest);
    const observations = assembleClaudeObservations(options);
    process.stdout.write(`${canonicalJson({
      observation_file: resolve(options.output),
      repetitions: observations.repetitions,
      runs: observations.runs.length,
      task_id: observations.task_id
    })}\n`);
    return observations;
  }
  throw new Error(USAGE);
}

const isMain = process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(ADAPTER_FILE);
if (isMain) {
  try { main(); } catch (error) {
    process.stderr.write(`[effectgate-claude-capture] ${error.message}\n`);
    process.exitCode = 2;
  }
}
