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

import { runProxy } from "../proxy/effectgate.mjs";
import { canonicalJson } from "../skill/passport-compiler.mjs";
import { BENCHMARK_PROFILES } from "./paired-harness.mjs";

const ADAPTER_FILE = fileURLToPath(import.meta.url);
const COMMIT = /^[a-f0-9]{40}$/u;
const RUN_ID = /^[A-Za-z0-9_-]{1,128}$/u;
const SOURCE = /^[A-Za-z0-9_.-]{1,64}$/u;
const TASK = /^BENCH-[A-Z0-9-]{1,64}$/u;
const MCP_PROFILES = new Set(["native_deferred", "compact_mux"]);
const PROFILE_IDS = new Set(Object.keys(BENCHMARK_PROFILES));
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024;
const USAGE = "Usage: claude-capture-adapter.mjs " +
  "mcp|dry-run --ledger-directory DIR --run-id ID --profile PROFILE " +
  "[--source NAME] [--host-evidence FILE] | normalize --input FILE " +
  "--output FILE --source-commit SHA --task-id ID --profile PROFILE " +
  "--repetition COUNT --host-version VERSION --observed-at TIMESTAMP";

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
  const { bytes, value, counts, totalInput } = rawCapture(input);
  const rawDigest = digest(bytes);
  const result = value.result;
  const capture = Object.freeze({
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
  const absoluteOutput = resolve(output);
  mkdirSync(dirname(absoluteOutput), { recursive: true, mode: 0o700 });
  writeFileSync(absoluteOutput, `${canonicalJson(capture)}\n`, {
    flag: "wx",
    mode: 0o600,
    flush: true
  });
  return capture;
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
