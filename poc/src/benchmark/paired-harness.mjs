import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, resolve } from "node:path";

export const BENCHMARK_PROFILES = Object.freeze({
  P0_NATIVE_DEFAULT: "native_default",
  P1_EG_TYPED: "native_deferred",
  P2_EG_MUX: "compact_mux",
  P3_EAGER_DIAGNOSTIC: "eager_diagnostic"
});

const PROFILE_IDS = Object.freeze(Object.keys(BENCHMARK_PROFILES));
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const TASK_PATTERN = /^BENCH-[A-Z0-9-]{1,64}$/u;
const FAILURE_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const TOKEN_BASES = new Set([
  "host_reported",
  "tokenizer_exact",
  "tokenizer_estimate",
  "byte_proxy",
  "counterfactual"
]);
const METRIC_KEYS = new Set([
  "task_success",
  "latency_ms",
  "fetch_count",
  "tool_call_count",
  "tool_schema_tokens",
  "tool_result_tokens",
  "total_input_tokens",
  "compatibility"
]);
const TOKEN_KEYS = new Set([
  "value",
  "basis",
  "counter_id",
  "counter_version",
  "input_digest",
  "calibration_error_bound"
]);
const COMPATIBILITY_KEYS = new Set([
  "native_deferral",
  "evidence_digest"
]);
const NATIVE_DEFERRAL_STATES = new Set([
  "qualified",
  "evidence_not_configured",
  "evidence_expired",
  "support_not_proven",
  "client_identity_mismatch",
  "profile_not_native_deferred",
  "not_applicable"
]);

function hash(value) {
  return createHash("sha256").update(value).digest("hex");
}

function boundedString(value, maximum = 128) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximum &&
    Buffer.byteLength(value, "utf8") <= maximum * 4 &&
    !value.includes("\0")
  );
}

function timestamp(value) {
  try {
    return new Date(value).toISOString();
  } catch {
    throw new TypeError("benchmark clock returned an invalid timestamp");
  }
}

function validTokenCount(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => TOKEN_KEYS.has(key)) &&
    Number.isSafeInteger(value.value) &&
    value.value >= 0 &&
    TOKEN_BASES.has(value.basis) &&
    boundedString(value.counter_id) &&
    boundedString(value.counter_version) &&
    DIGEST_PATTERN.test(value.input_digest) &&
    (value.calibration_error_bound === undefined ||
      (Number.isFinite(value.calibration_error_bound) &&
        value.calibration_error_bound >= 0 &&
        value.calibration_error_bound <= 1))
  );
}

function validCompatibility(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => COMPATIBILITY_KEYS.has(key)) &&
    NATIVE_DEFERRAL_STATES.has(value.native_deferral) &&
    (value.evidence_digest === undefined ||
      DIGEST_PATTERN.test(value.evidence_digest))
  );
}

function validatedMetrics(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !METRIC_KEYS.has(key)) ||
    typeof value.task_success !== "boolean" ||
    !Number.isFinite(value.latency_ms) ||
    value.latency_ms < 0 ||
    !Number.isSafeInteger(value.fetch_count) ||
    value.fetch_count < 0 ||
    !Number.isSafeInteger(value.tool_call_count) ||
    value.tool_call_count < 0 ||
    !validTokenCount(value.tool_schema_tokens) ||
    !validTokenCount(value.tool_result_tokens) ||
    (value.total_input_tokens !== undefined &&
      !validTokenCount(value.total_input_tokens)) ||
    !validCompatibility(value.compatibility)
  ) {
    throw new TypeError("invalid benchmark metrics");
  }
  return Object.freeze({
    ...value,
    tool_schema_tokens: Object.freeze({ ...value.tool_schema_tokens }),
    tool_result_tokens: Object.freeze({ ...value.tool_result_tokens }),
    compatibility: Object.freeze({ ...value.compatibility }),
    ...(value.total_input_tokens === undefined
      ? {}
      : {
          total_input_tokens: Object.freeze({ ...value.total_input_tokens })
        })
  });
}

function profileOrder(seed, repetition) {
  return [...PROFILE_IDS].sort((left, right) => {
    const leftKey = hash(`${seed}\0${repetition}\0${left}`);
    const rightKey = hash(`${seed}\0${repetition}\0${right}`);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function failureCode(error) {
  return typeof error?.code === "string" && FAILURE_PATTERN.test(error.code)
    ? error.code
    : error instanceof TypeError && error.message === "invalid benchmark metrics"
      ? "invalid_result"
      : "runner_error";
}

function append(file, value) {
  fs.appendFileSync(file, `${JSON.stringify(value)}\n`, {
    encoding: "utf8",
    mode: 0o600,
    flush: true
  });
}

export async function runPairedBenchmark({
  file,
  taskId,
  seed,
  repetitions,
  backendDigest,
  promptDigest,
  rubricDigest,
  model,
  effort,
  hostVersion,
  machineClass,
  runProfile,
  now = Date.now
}) {
  if (
    !boundedString(file, 1024) ||
    !TASK_PATTERN.test(taskId) ||
    !boundedString(seed) ||
    !Number.isSafeInteger(repetitions) ||
    repetitions < 1 ||
    repetitions > 1_000 ||
    !DIGEST_PATTERN.test(backendDigest) ||
    !DIGEST_PATTERN.test(promptDigest) ||
    !DIGEST_PATTERN.test(rubricDigest) ||
    !boundedString(model) ||
    !boundedString(effort, 64) ||
    !boundedString(hostVersion) ||
    !boundedString(machineClass) ||
    typeof runProfile !== "function" ||
    typeof now !== "function"
  ) {
    throw new TypeError("invalid paired benchmark configuration");
  }

  const evidenceFile = resolve(file);
  const header = Object.freeze({
    kind: "effectgate_paired_benchmark",
    schema_version: "1.0.0",
    task_id: taskId,
    seed,
    repetitions,
    profiles: PROFILE_IDS,
    backend_digest: backendDigest,
    prompt_digest: promptDigest,
    rubric_digest: rubricDigest,
    model,
    effort,
    host_version: hostVersion,
    machine_class: machineClass,
    created_at: timestamp(now())
  });
  fs.mkdirSync(dirname(evidenceFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(evidenceFile, `${JSON.stringify(header)}\n`, {
    flag: "wx",
    mode: 0o600,
    flush: true
  });

  const events = [];
  for (let repetition = 0; repetition < repetitions; repetition += 1) {
    const pairId = `pair_${hash(`${taskId}\0${seed}\0${repetition}`)}`;
    const order = profileOrder(seed, repetition);
    for (const [orderIndex, profile] of order.entries()) {
      const runId = `run_${hash(`${pairId}\0${profile}`)}`;
      const context = Object.freeze({
        taskId,
        repetition,
        orderIndex,
        pairId,
        runId,
        profile,
        ledgerProfile: BENCHMARK_PROFILES[profile]
      });
      let event;
      try {
        const metrics = validatedMetrics(await runProfile(context));
        event = Object.freeze({
          kind: "run",
          pair_id: pairId,
          run_id: runId,
          task_id: taskId,
          repetition,
          order_index: orderIndex,
          profile,
          status: "completed",
          metrics,
          observed_at: timestamp(now())
        });
      } catch (error) {
        event = Object.freeze({
          kind: "run",
          pair_id: pairId,
          run_id: runId,
          task_id: taskId,
          repetition,
          order_index: orderIndex,
          profile,
          status: "failed",
          failure_code: failureCode(error),
          observed_at: timestamp(now())
        });
      }
      append(evidenceFile, event);
      events.push(event);
    }
  }

  return Object.freeze({
    file: evidenceFile,
    header,
    events: Object.freeze(events)
  });
}
