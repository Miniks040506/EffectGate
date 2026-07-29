import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { runPairedBenchmark } from "../src/benchmark/paired-harness.mjs";
import {
  generateExposureRecommendation
} from "../src/benchmark/exposure-recommender.mjs";
import {
  writeExposureRecommendation
} from "../src/benchmark/exposure-recommendation-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRAM = fileURLToPath(new URL(
  "../src/benchmark/exposure-recommendation-cli.mjs", import.meta.url
));
const CONTRACT = JSON.parse(readFileSync(join(
  HERE, "..", "..", "contracts", "exposure-recommendation.schema.json"
), "utf8"));

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-recommend-"));
  return {
    directory,
    evidence: join(directory, "evidence.jsonl"),
    output: join(directory, "recommendation.json"),
    close: () => rmSync(directory, { recursive: true, force: true })
  };
}

function count(value, basis, counterId) {
  return {
    value,
    basis,
    counter_id: counterId,
    counter_version: "1",
    input_digest: digest(`${value}:${basis}:${counterId}`)
  };
}

function metrics(
  { profile, repetition },
  typedState,
  { partialTokens = false, splitEvidence = false } = {}
) {
  const values = {
    P0_NATIVE_DEFAULT: { latency: 100, tokens: 100 },
    P1_EG_TYPED: { latency: 110, tokens: 50 },
    P2_EG_MUX: { latency: 110, tokens: 45 },
    P3_EAGER_DIAGNOSTIC: { latency: 150, tokens: 150 }
  }[profile];
  const compatibility = profile === "P1_EG_TYPED"
    ? {
        native_deferral: typedState,
        ...(["qualified", "native_deferral_unavailable"].includes(typedState)
          ? {
              evidence_digest: digest(
                splitEvidence && repetition % 2 === 1
                  ? "second-host-build"
                  : "qualified-host-build"
              )
            }
          : {})
      }
    : {
        native_deferral: profile === "P2_EG_MUX"
          ? "profile_not_native_deferred"
          : "not_applicable"
      };
  return {
    task_success: true,
    latency_ms: values.latency,
    fetch_count: 0,
    tool_call_count: 1,
    tool_schema_tokens: count(
      20, "byte_proxy", "utf8-bytes-ceil-div-4"
    ),
    tool_result_tokens: count(
      30, "byte_proxy", "utf8-bytes-ceil-div-4"
    ),
    compatibility,
    ...(partialTokens && repetition > 0
      ? {}
      : {
          total_input_tokens: count(
            values.tokens, "host_reported", "fixture-host-usage"
          )
        })
  };
}

function benchmark(file, typedState, repetitions = 30, options = {}) {
  return runPairedBenchmark({
    file,
    taskId: "BENCH-READ-032",
    seed: "exposure-recommendation-seed-v1",
    repetitions,
    backendDigest: digest("backend"),
    promptDigest: digest("prompt"),
    rubricDigest: digest("rubric"),
    model: "fixture-model",
    effort: "none",
    hostVersion: "fixture-host-1",
    machineClass: "fixture-machine",
    now: () => Date.parse("2026-07-29T00:00:00.000Z"),
    runProfile: (context) => metrics(context, typedState, options)
  });
}

function assertKeys(value, schema) {
  assert.deepEqual(Object.keys(value).sort(), schema.required.toSorted());
}

function assertContract(recommendation) {
  assertKeys(recommendation, CONTRACT);
  assert.equal(
    recommendation.kind,
    CONTRACT.properties.kind.const
  );
  assert.equal(
    recommendation.schema_version,
    CONTRACT.properties.schema_version.const
  );
  const digestPattern = new RegExp(CONTRACT.$defs.digest.pattern, "u");
  for (const key of [
    "recommendation_id",
    "report_digest",
    "evidence_digest",
    "threshold_revision"
  ]) {
    assert.match(recommendation[key], digestPattern);
  }
  for (const value of recommendation.gates) {
    assertKeys(value, CONTRACT.$defs.gate);
  }
}

test("recommends native deferral without applying it", async () => {
  const files = fixture();
  try {
    await benchmark(files.evidence, "qualified");
    const first = generateExposureRecommendation({
      evidenceFile: files.evidence
    });
    const second = generateExposureRecommendation({
      evidenceFile: files.evidence
    });
    assert.deepEqual(first, second);
    assert.equal(Object.isFrozen(first), true);
    assertContract(first);
    assert.equal(first.status, "suggested");
    assert.equal(first.suggested_profile, "native_deferred");
    assert.equal(first.current_default_profile, "native_deferred");
    assert.equal(first.review_required, true);
    assert.equal(first.automatic_application, false);
    assert.equal(first.policy_mutation_allowed, false);
    assert.ok(first.gates.every(({ passed }) => passed));
    assert.deepEqual(first.reasons, ["native_deferred_gates_passed"]);
    assert.equal(JSON.stringify(first).includes("direct_bypass"), false);

    const written = writeExposureRecommendation({
      evidenceFile: files.evidence,
      output: files.output
    });
    assert.deepEqual(
      JSON.parse(readFileSync(written.file, "utf8")),
      first
    );
    assert.throws(() => writeExposureRecommendation({
      evidenceFile: files.evidence,
      output: files.output
    }), { code: "EEXIST" });
  } finally {
    files.close();
  }
});

test("compact mux requires proven typed-deferral unsuitability", async () => {
  const proven = fixture();
  const unknown = fixture();
  const incomplete = fixture();
  try {
    await benchmark(proven.evidence, "native_deferral_unavailable");
    const compact = generateExposureRecommendation({
      evidenceFile: proven.evidence
    });
    assert.equal(compact.status, "suggested");
    assert.equal(compact.suggested_profile, "compact_mux");
    assert.deepEqual(compact.reasons, [
      "typed_deferral_unsuitable",
      "compact_mux_gates_passed"
    ]);
    assert.equal(
      compact.gates.find(({ gate }) =>
        gate === "typed_deferral_unsuitable").passed,
      true
    );

    await benchmark(unknown.evidence, "evidence_not_configured");
    const hold = generateExposureRecommendation({
      evidenceFile: unknown.evidence
    });
    assert.equal(hold.status, "hold");
    assert.equal(hold.suggested_profile, null);
    assert.ok(hold.reasons.includes("native_deferral_not_qualified"));
    assert.equal(
      hold.gates.some(({ gate, profile }) =>
        gate === "candidate_profile_present" &&
        profile === "P2_EG_MUX"),
      false
    );

    await benchmark(incomplete.evidence, "qualified", 30, {
      partialTokens: true,
      splitEvidence: true
    });
    const incompleteHold = generateExposureRecommendation({
      evidenceFile: incomplete.evidence
    });
    assert.equal(incompleteHold.status, "hold");
    assert.ok(incompleteHold.reasons.includes(
      "comparable_measured_tokens_unavailable"
    ));
    assert.ok(incompleteHold.reasons.includes(
      "native_deferral_not_qualified"
    ));
  } finally {
    proven.close();
    unknown.close();
    incomplete.close();
  }
});

test("insufficient evidence holds and CLI output is exclusive", async () => {
  const files = fixture();
  try {
    await benchmark(files.evidence, "qualified", 1);
    const run = spawnSync(process.execPath, [
      PROGRAM,
      "--evidence",
      files.evidence,
      "--output",
      files.output
    ], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      recommendation_file: files.output,
      status: "hold",
      suggested_profile: null,
      review_required: true
    });
    const recommendation = JSON.parse(
      readFileSync(files.output, "utf8")
    );
    assert.equal(recommendation.status, "hold");
    assert.ok(
      recommendation.reasons.includes("minimum_repetitions_not_met")
    );

    const repeated = spawnSync(process.execPath, [
      PROGRAM,
      "--evidence",
      files.evidence,
      "--output",
      files.output
    ], { encoding: "utf8" });
    assert.equal(repeated.status, 2);
    assert.match(repeated.stderr, /\bEEXIST\b/u);
  } finally {
    files.close();
  }
});
