import { createHash } from "node:crypto";

import { generateBenchmarkReport } from "./statistical-report.mjs";
import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";

const THRESHOLDS = Object.freeze({
  minimum_repetitions: 30,
  maximum_task_success_delta: 0.02,
  maximum_fetch_rate: 0.10,
  maximum_latency_overhead: 0.15,
  minimum_total_input_token_reduction: 0.40
});
const MEASURED_BASES = new Set(["host_reported", "tokenizer_exact"]);
const REQUIRED_PROFILES = [
  "P0_NATIVE_DEFAULT", "P1_EG_TYPED", "P2_EG_MUX"
];

function digest(domain, value) {
  return `sha256:${createHash("sha256")
    .update(`${domain}\0`)
    .update(canonicalJson(value))
    .digest("hex")}`;
}

const THRESHOLD_REVISION = digest(
  "effectgate.exposure-thresholds.v1", THRESHOLDS
);

function display(value) {
  return Number.isFinite(value)
    ? String(Number(value.toFixed(6)))
    : "unavailable";
}

function gate(
  name, profile, passed, observed, threshold, failureReason
) {
  return {
    gate: name,
    profile,
    passed,
    observed,
    threshold,
    safe_reason_code: passed ? `${name}_passed` : failureReason
  };
}

function profile(report, id) {
  return report.profile_reports.find(({ profile: value }) => value === id);
}

function rate(report, metric) {
  return report?.rates.find(({ metric: value }) => value === metric)?.summary;
}

function measurement(report, metric, predicate = () => true) {
  return report?.measurements.filter((value) =>
    value.metric === metric && predicate(value)) ?? [];
}

function measuredTokenPair(baseline, candidate) {
  const baselineCounts = measurement(
    baseline,
    "total_input_tokens",
    ({ basis, summary }) => MEASURED_BASES.has(basis) &&
      summary.samples === baseline.completed_runs
  );
  const pairs = baselineCounts.flatMap((left) =>
    measurement(candidate, "total_input_tokens", (right) =>
      right.basis === left.basis &&
      right.counter_id === left.counter_id &&
      right.counter_version === left.counter_version &&
      right.summary.samples === candidate.completed_runs
    ).map((right) => [left, right]));
  return pairs.length === 1 ? pairs[0] : undefined;
}

function candidateGates(report, profileId, requireCompatibility) {
  const baseline = profile(report, "P0_NATIVE_DEFAULT");
  const candidate = profile(report, profileId);
  const gates = [gate(
    "candidate_profile_present",
    profileId,
    candidate !== undefined,
    candidate === undefined ? "missing" : "present",
    "present",
    "candidate_profile_missing"
  )];
  if (!candidate || !baseline) return gates;
  gates.push(gate(
    "candidate_failure_free",
    profileId,
    candidate.failed_runs === 0,
    String(candidate.failed_runs),
    "0",
    "candidate_failures_present"
  ));

  const baselineSuccess = rate(baseline, "task_success");
  const candidateSuccess = rate(candidate, "task_success");
  const successDelta = baselineSuccess && candidateSuccess
    ? candidateSuccess.confidence_interval_95.lower -
      baselineSuccess.confidence_interval_95.upper
    : Number.NaN;
  gates.push(gate(
    "task_success_delta",
    profileId,
    successDelta >= -THRESHOLDS.maximum_task_success_delta,
    display(successDelta),
    `>=-${THRESHOLDS.maximum_task_success_delta}`,
    "task_success_gate_failed"
  ));

  const fetch = rate(candidate, "fetch_required");
  const fetchUpper = fetch?.confidence_interval_95.upper ?? Number.NaN;
  gates.push(gate(
    "additional_fetch_rate",
    profileId,
    fetchUpper <= THRESHOLDS.maximum_fetch_rate,
    display(fetchUpper),
    `<=${THRESHOLDS.maximum_fetch_rate}`,
    "fetch_rate_gate_failed"
  ));

  const baselineLatency =
    measurement(baseline, "latency_ms")[0]?.summary;
  const candidateLatency =
    measurement(candidate, "latency_ms")[0]?.summary;
  const latencyOverhead = baselineLatency && candidateLatency &&
      baselineLatency.median_ci_95.lower > 0
    ? candidateLatency.median_ci_95.upper /
      baselineLatency.median_ci_95.lower - 1
    : Number.NaN;
  gates.push(gate(
    "latency_overhead",
    profileId,
    latencyOverhead <= THRESHOLDS.maximum_latency_overhead,
    display(latencyOverhead),
    `<=${THRESHOLDS.maximum_latency_overhead}`,
    "latency_gate_failed"
  ));

  const tokenPair = measuredTokenPair(baseline, candidate);
  const tokenReduction = tokenPair &&
      tokenPair[0].summary.median_ci_95.lower > 0
    ? 1 - tokenPair[1].summary.median_ci_95.upper /
      tokenPair[0].summary.median_ci_95.lower
    : Number.NaN;
  gates.push(gate(
    "measured_total_input_token_reduction",
    profileId,
    tokenReduction >= THRESHOLDS.minimum_total_input_token_reduction,
    display(tokenReduction),
    `>=${THRESHOLDS.minimum_total_input_token_reduction}`,
    tokenPair
      ? "token_reduction_gate_failed"
      : "comparable_measured_tokens_unavailable"
  ));

  if (requireCompatibility) {
    const qualified = candidate.compatibility.find(
      ({ state }) => state === "qualified"
    );
    const compatible = candidate.completed_runs > 0 &&
      qualified?.count === candidate.completed_runs &&
      qualified.evidence_digests.length === 1;
    gates.push(gate(
      "native_deferral_compatibility",
      profileId,
      compatible,
      compatible ? "qualified" : "not_qualified",
      "all completed runs qualified with evidence",
      "native_deferral_not_qualified"
    ));
  }
  return gates;
}

function typedDeferralUnsuitable(report) {
  const typed = profile(report, "P1_EG_TYPED");
  const compatibility = typed?.compatibility[0];
  return typed !== undefined &&
    typed.failed_runs === 0 &&
    typed.completed_runs === report.repetitions &&
    typed.compatibility.length === 1 &&
    compatibility.state === "native_deferral_unavailable" &&
    compatibility.count === typed.completed_runs &&
    compatibility.evidence_digests.length === 1;
}

function failedReasons(gates) {
  return [...new Set(gates.filter(({ passed }) => !passed)
    .map(({ safe_reason_code: reason }) => reason))];
}

export function generateExposureRecommendation({
  evidenceFile
} = {}) {
  const report = generateBenchmarkReport({ file: evidenceFile });
  const baseline = profile(report, "P0_NATIVE_DEFAULT");
  const matrixPresent = REQUIRED_PROFILES.every((id) =>
    report.profiles.includes(id));
  const globalGates = [
    gate(
      "minimum_repetitions",
      null,
      report.minimum_repetitions_met,
      String(report.repetitions),
      `>=${THRESHOLDS.minimum_repetitions}`,
      "minimum_repetitions_not_met"
    ),
    gate(
      "effect_profile_matrix",
      null,
      matrixPresent,
      matrixPresent ? "complete" : "incomplete",
      REQUIRED_PROFILES.join(","),
      "effect_profile_matrix_incomplete"
    ),
    gate(
      "baseline_failure_free",
      "P0_NATIVE_DEFAULT",
      baseline?.failed_runs === 0,
      baseline === undefined ? "missing" : String(baseline.failed_runs),
      "0",
      "baseline_failures_present"
    )
  ];
  const typedGates = candidateGates(
    report, "P1_EG_TYPED", true
  );
  const globalPassed = globalGates.every(({ passed }) => passed);
  const typedPassed = typedGates.every(({ passed }) => passed);
  let gates = [...globalGates, ...typedGates];
  let suggestedProfile = null;
  let reasons;
  if (globalPassed && typedPassed) {
    suggestedProfile = "native_deferred";
    reasons = ["native_deferred_gates_passed"];
  } else if (globalPassed && typedDeferralUnsuitable(report)) {
    const muxGates = candidateGates(report, "P2_EG_MUX", false);
    gates = [...gates, gate(
      "typed_deferral_unsuitable",
      "P1_EG_TYPED",
      true,
      "proven",
      "all runs have exact disabled-observed evidence",
      "typed_deferral_suitability_unknown"
    ), ...muxGates];
    if (muxGates.every(({ passed }) => passed)) {
      suggestedProfile = "compact_mux";
      reasons = [
        "typed_deferral_unsuitable",
        "compact_mux_gates_passed"
      ];
    }
  }
  reasons ??= failedReasons(gates);
  if (reasons.length === 0) reasons = ["insufficient_exposure_evidence"];
  const reportDigest = digest(
    "effectgate.benchmark-report.v1", report
  );
  const body = {
    report_digest: reportDigest,
    evidence_digest: report.evidence_digest,
    task_id: report.task_id,
    threshold_revision: THRESHOLD_REVISION,
    status: suggestedProfile === null ? "hold" : "suggested",
    suggested_profile: suggestedProfile,
    current_default_profile: "native_deferred",
    review_required: true,
    automatic_application: false,
    policy_mutation_allowed: false,
    gates,
    reasons
  };
  return deepFreeze({
    kind: "effectgate_exposure_recommendation",
    schema_version: "1.0.0",
    recommendation_id: digest(
      "effectgate.exposure-recommendation.v1", body
    ),
    ...body
  });
}
