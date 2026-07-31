#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";

import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";
import { generateBenchmarkReport } from "./statistical-report.mjs";

export const SMALL_READ_THRESHOLDS = Object.freeze({
  minimum_repetitions: 30,
  maximum_task_success_delta_points: 2,
  maximum_typed_median_latency_overhead: 0.15
});

const TASK_ID = "BENCH-SMALL-005";
const USAGE = "Usage: performance-gate.mjs --input FILE";

function profile(report, id) {
  const value = report.profile_reports.find(
    ({ profile: candidate }) => candidate === id
  );
  if (value === undefined) throw new TypeError("missing benchmark profile");
  return value;
}

function latency(value) {
  const summary = value.measurements.find(
    ({ metric, basis }) => metric === "latency_ms" && basis === "runtime"
  )?.summary;
  if (
    !Number.isFinite(summary?.median) ||
    summary.median <= 0 ||
    !Number.isFinite(summary?.p95) ||
    summary.p95 <= 0
  ) {
    throw new TypeError("invalid benchmark latency");
  }
  return summary;
}

function successRate(value) {
  const rate = value.rates.find(
    ({ metric }) => metric === "task_success"
  )?.summary?.rate;
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new TypeError("invalid benchmark success rate");
  }
  return rate;
}

function round(value) {
  return Number(value.toFixed(6));
}

export function qualifySmallReadPerformance({ file } = {}) {
  const report = generateBenchmarkReport({ file });
  if (report.task_id !== TASK_ID) {
    throw new TypeError("performance gate requires BENCH-SMALL-005 evidence");
  }
  const native = profile(report, "P0_NATIVE_DEFAULT");
  const typed = profile(report, "P1_EG_TYPED");
  const nativeLatency = latency(native);
  const typedLatency = latency(typed);
  const nativeSuccess = successRate(native);
  const typedSuccess = successRate(typed);
  const medianOverhead = round(
    typedLatency.median / nativeLatency.median - 1
  );
  const p95Overhead = round(typedLatency.p95 / nativeLatency.p95 - 1);
  const successDelta = round(
    Math.max(0, nativeSuccess - typedSuccess) * 100
  );
  const checks = {
    minimum_repetitions:
      report.repetitions >= SMALL_READ_THRESHOLDS.minimum_repetitions,
    complete_profile_evidence:
      [native, typed].every((value) =>
        value.expected_runs === report.repetitions &&
        value.completed_runs === report.repetitions &&
        value.failed_runs === 0),
    task_success_delta:
      successDelta <=
        SMALL_READ_THRESHOLDS.maximum_task_success_delta_points,
    typed_median_latency_overhead:
      medianOverhead <=
        SMALL_READ_THRESHOLDS.maximum_typed_median_latency_overhead
  };
  return deepFreeze({
    kind: "effectgate_small_read_performance_qualification",
    schema_version: "1.0.0",
    evidence_digest: report.evidence_digest,
    task_id: report.task_id,
    machine_class: report.machine_class,
    repetitions: report.repetitions,
    thresholds: SMALL_READ_THRESHOLDS,
    measurements: {
      native_task_success_rate: nativeSuccess,
      typed_task_success_rate: typedSuccess,
      typed_task_success_delta_points: successDelta,
      native_median_latency_ms: nativeLatency.median,
      typed_median_latency_ms: typedLatency.median,
      typed_added_median_latency_ms: round(
        typedLatency.median - nativeLatency.median
      ),
      typed_median_latency_overhead: medianOverhead,
      native_p95_latency_ms: nativeLatency.p95,
      typed_p95_latency_ms: typedLatency.p95,
      typed_added_p95_latency_ms: round(
        typedLatency.p95 - nativeLatency.p95
      ),
      typed_p95_latency_overhead: p95Overhead
    },
    checks,
    verdict: Object.values(checks).every(Boolean) ? "pass" : "fail"
  });
}

function parseArguments(args) {
  if (args.length !== 2 || args[0] !== "--input") throw new Error(USAGE);
  return { file: args[1] };
}

export function main(args = process.argv.slice(2)) {
  const qualification = qualifySmallReadPerformance(parseArguments(args));
  process.stdout.write(`${canonicalJson(qualification)}\n`);
  return qualification;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    if (main().verdict === "fail") process.exitCode = 1;
  } catch (error) {
    process.stderr.write(`[effectgate-performance] ${error.message}\n`);
    process.exitCode = 2;
  }
}
