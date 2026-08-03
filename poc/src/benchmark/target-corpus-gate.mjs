#!/usr/bin/env node

import {
  lstatSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  canonicalJson,
  deepFreeze
} from "../skill/passport-compiler.mjs";
import { generateBenchmarkReport } from "./statistical-report.mjs";

const COMMIT = /^[a-f0-9]{40}$/u;
const MEASURED_BASES = new Set(["host_reported", "tokenizer_exact"]);
const RESULT_BASES = new Set([
  "host_reported", "tokenizer_exact", "tokenizer_estimate", "byte_proxy"
]);
const TASKS = Object.freeze([
  "BENCH-READ-001",
  "BENCH-JSON-002",
  "BENCH-STREAM-003",
  "BENCH-TABLE-004"
]);
export const TARGET_THRESHOLDS = Object.freeze({
  minimum_model_repetitions: 20,
  minimum_first_view_reduction: 0.70,
  minimum_total_input_reduction: 0.40,
  minimum_h11_total_input_reduction: 0.25,
  maximum_task_success_delta: 0.02,
  maximum_additional_fetch_rate: 0.10
});
const USAGE = "Usage: target-corpus-gate.mjs --input FILE";

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function readManifest(file) {
  const absolute = resolve(file);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.size < 2 || stat.size > 64 * 1024) {
    throw new TypeError("invalid target-corpus manifest");
  }
  const source = readFileSync(realpathSync(absolute), "utf8");
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new TypeError("invalid target-corpus manifest");
  }
  if (source !== `${canonicalJson(value)}\n` ||
      !exact(value, ["source_commit", "evidence"]) ||
      !COMMIT.test(value.source_commit ?? "") ||
      !Array.isArray(value.evidence) || value.evidence.length !== TASKS.length ||
      value.evidence.some((entry) =>
        !exact(entry, ["task_id", "path"]) ||
        !TASKS.includes(entry.task_id) || typeof entry.path !== "string" ||
        entry.path.length < 1 || entry.path.length > 1024 ||
        entry.path.includes("\0")) ||
      canonicalJson(value.evidence.map(({ task_id: id }) => id).sort()) !==
        canonicalJson([...TASKS].sort())) {
    throw new TypeError("invalid target-corpus manifest");
  }
  return { root: dirname(realpathSync(absolute)), value };
}

function profile(report, id) {
  return report.profile_reports.find(({ profile: value }) => value === id);
}

function rate(value, metric) {
  return value?.rates.find(({ metric: name }) => name === metric)?.summary;
}

function tokenReduction(baseline, candidate, metric, bases) {
  const left = baseline?.measurements.filter((item) =>
    item.metric === metric && bases.has(item.basis) &&
    item.summary.samples === baseline.completed_runs) ?? [];
  const pairs = left.flatMap((item) => candidate?.measurements.filter(
    (right) => right.metric === metric && right.basis === item.basis &&
      right.counter_id === item.counter_id &&
      right.counter_version === item.counter_version &&
      right.summary.samples === candidate.completed_runs
  ).map((right) => [item, right]) ?? []);
  if (pairs.length !== 1 || pairs[0][0].summary.median_ci_95.lower <= 0) {
    return null;
  }
  return Number((1 - pairs[0][1].summary.median_ci_95.upper /
    pairs[0][0].summary.median_ci_95.lower).toFixed(6));
}

function qualifyTask(report) {
  const native = profile(report, "P0_NATIVE_DEFAULT");
  const typed = profile(report, "P1_EG_TYPED");
  const nativeSuccess = rate(native, "task_success");
  const typedSuccess = rate(typed, "task_success");
  const fetch = rate(typed, "fetch_required");
  const firstViewReduction = tokenReduction(
    native, typed, "tool_result_tokens", RESULT_BASES
  );
  const totalInputReduction = tokenReduction(
    native, typed, "total_input_tokens", MEASURED_BASES
  );
  const successDelta = nativeSuccess && typedSuccess
    ? Number(Math.max(0, nativeSuccess.confidence_interval_95.upper -
      typedSuccess.confidence_interval_95.lower).toFixed(6))
    : null;
  const fetchUpper = fetch?.confidence_interval_95.upper ?? null;
  const compatibility = typed?.compatibility.find(
    ({ state }) => state === "qualified"
  );
  const checks = {
    minimum_model_repetitions:
      report.repetitions >= TARGET_THRESHOLDS.minimum_model_repetitions,
    complete_profile_evidence: [native, typed].every((item) => item &&
      item.expected_runs === report.repetitions &&
      item.completed_runs === report.repetitions && item.failed_runs === 0),
    real_model_evidence:
      !report.model.startsWith("deterministic-") && report.effort !== "none",
    native_deferral_compatibility:
      compatibility?.count === report.repetitions &&
      compatibility.evidence_digests.length === 1,
    task_success_delta: successDelta !== null &&
      successDelta <= TARGET_THRESHOLDS.maximum_task_success_delta,
    additional_fetch_rate: fetchUpper !== null &&
      fetchUpper <= TARGET_THRESHOLDS.maximum_additional_fetch_rate,
    first_view_reduction: firstViewReduction !== null &&
      firstViewReduction >= TARGET_THRESHOLDS.minimum_first_view_reduction,
    total_input_reduction: totalInputReduction !== null &&
      totalInputReduction >= TARGET_THRESHOLDS.minimum_total_input_reduction
  };
  return {
    task_id: report.task_id,
    evidence_digest: report.evidence_digest,
    repetitions: report.repetitions,
    measurements: {
      additional_fetch_rate_upper: fetchUpper,
      first_view_reduction: firstViewReduction,
      task_success_delta: successDelta,
      total_input_reduction: totalInputReduction
    },
    checks,
    verdict: Object.values(checks).every(Boolean) ? "pass" : "fail"
  };
}

function median(values) {
  if (values.some((value) => value === null)) return null;
  const sorted = values.toSorted((left, right) => left - right);
  return Number(((sorted[1] + sorted[2]) / 2).toFixed(6));
}

export function qualifyTargetCorpus({ input } = {}) {
  if (typeof input !== "string" || input.length < 1 || input.includes("\0")) {
    throw new TypeError("invalid target-corpus configuration");
  }
  const { root, value } = readManifest(input);
  const paths = value.evidence.map(({ path }) => {
    const absolute = resolve(root, path);
    if (!lstatSync(absolute).isFile()) {
      throw new TypeError("target-corpus evidence must be a regular file");
    }
    return realpathSync(absolute);
  });
  if (new Set(paths).size !== paths.length) {
    throw new TypeError("target-corpus evidence files must be unique");
  }
  const reports = value.evidence.map(({ task_id: taskId }, index) => {
    const report = generateBenchmarkReport({ file: paths[index] });
    if (report.task_id !== taskId) {
      throw new TypeError("target-corpus task does not match its evidence");
    }
    return report;
  }).sort((left, right) => left.task_id.localeCompare(right.task_id));
  const environments = [...new Map(reports.map((report) => {
    const environment = {
      backend_digest: report.backend_digest,
      effort: report.effort,
      host_version: report.host_version,
      machine_class: report.machine_class,
      model: report.model
    };
    return [canonicalJson(environment), environment];
  })).values()];
  const tasks = reports.map(qualifyTask);
  const reductions = tasks.map(
    ({ measurements }) => measurements.total_input_reduction
  );
  const totalInputMedian = median(reductions);
  const checks = {
    consistent_environment: environments.length === 1,
    complete_task_set:
      canonicalJson(reports.map(({ task_id: id }) => id).sort()) ===
        canonicalJson([...TASKS].sort()),
    all_tasks_pass: tasks.every(({ verdict }) => verdict === "pass"),
    h11_token_value: totalInputMedian !== null && totalInputMedian >=
      TARGET_THRESHOLDS.minimum_h11_total_input_reduction,
    p0_total_input_reduction: totalInputMedian !== null && totalInputMedian >=
      TARGET_THRESHOLDS.minimum_total_input_reduction
  };
  const reasons = Object.entries(checks)
    .filter(([, passed]) => !passed)
    .map(([name]) => `${name}_failed`);
  return deepFreeze({
    kind: "effectgate_target_corpus_qualification",
    schema_version: "1.0.0",
    source_commit: value.source_commit,
    thresholds: TARGET_THRESHOLDS,
    environments,
    tasks,
    measurements: { total_input_reduction_median: totalInputMedian },
    checks,
    reasons,
    verdict: reasons.length === 0 ? "pass" : "fail"
  });
}

export function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--input") throw new Error(USAGE);
  const qualification = qualifyTargetCorpus({ input: args[1] });
  process.stdout.write(`${canonicalJson(qualification)}\n`);
  if (qualification.verdict === "fail") process.exitCode = 1;
  return qualification;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`[effectgate-target-corpus] ${error.message}\n`);
    process.exitCode = 2;
  }
}
