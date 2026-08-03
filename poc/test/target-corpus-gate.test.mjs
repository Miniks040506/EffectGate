import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../src/skill/passport-compiler.mjs";
import {
  runObservedBenchmark
} from "../src/benchmark/observation-runner.mjs";
import {
  qualifyTargetCorpus
} from "../src/benchmark/target-corpus-gate.mjs";

const PROGRAM = fileURLToPath(new URL(
  "../src/benchmark/target-corpus-gate.mjs", import.meta.url
));
const COMMIT = "a".repeat(40);
const PROFILES = [
  "P0_NATIVE_DEFAULT",
  "P1_EG_TYPED",
  "P2_EG_MUX",
  "P3_EAGER_DIAGNOSTIC"
];
const TASKS = [
  "BENCH-READ-001",
  "BENCH-JSON-002",
  "BENCH-STREAM-003",
  "BENCH-TABLE-004"
];

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function count(value, basis, counterId) {
  return {
    basis,
    counter_id: counterId,
    counter_version: "1",
    input_digest: digest(`${basis}:${counterId}:${value}`),
    value
  };
}

function metrics(profile, measured) {
  const values = {
    P0_NATIVE_DEFAULT: { result: 10_000, total: 1_000 },
    P1_EG_TYPED: { result: 2_000, total: 400 },
    P2_EG_MUX: { result: 1_800, total: 350 },
    P3_EAGER_DIAGNOSTIC: { result: 12_000, total: 1_200 }
  }[profile];
  return {
    task_success: true,
    latency_ms: profile === "P0_NATIVE_DEFAULT" ? 100 : 110,
    fetch_count: 0,
    tool_call_count: profile === "P2_EG_MUX" ? 3 : 1,
    tool_schema_tokens: count(100, "byte_proxy", "utf8-bytes-ceil-div-4"),
    tool_result_tokens: count(
      values.result, "byte_proxy", "utf8-bytes-ceil-div-4"
    ),
    total_input_tokens: count(
      values.total,
      measured ? "host_reported" : "byte_proxy",
      measured ? "host-usage" : "utf8-bytes-ceil-div-4"
    ),
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
  };
}

function writeCanonical(file, value) {
  writeFileSync(file, `${canonicalJson(value)}\n`, "utf8");
  return file;
}

async function observedEvidence(root, taskId, measured, suffix) {
  const input = join(root, `${taskId}-${suffix}-observations.json`);
  const output = join(root, `${taskId}-${suffix}.jsonl`);
  const runs = Array.from({ length: 20 }, (_, repetition) =>
    PROFILES.map((profile) => ({
      metrics: metrics(profile, measured),
      profile,
      repetition
    }))).flat();
  writeCanonical(input, {
    backend_digest: digest("target-backend"),
    effort: "medium",
    host_version: "qualification-host-1",
    kind: "effectgate_benchmark_observations",
    machine_class: "qualification-machine",
    model: "qualification-model",
    observed_at: "2026-08-03T00:00:00.000Z",
    prompt_digest: digest(`${taskId}:prompt`),
    repetitions: 20,
    rubric_digest: digest(`${taskId}:rubric`),
    runs,
    schema_version: "1.0.0",
    seed: `${taskId.toLowerCase()}-${suffix}`,
    source_commit: COMMIT,
    task_id: taskId
  });
  const result = await runObservedBenchmark({ input, output });
  assert.equal(result.source_commit, COMMIT);
  assert.equal(result.benchmark.events.length, 80);
  assert.ok(result.benchmark.events.every(
    ({ status }) => status === "completed"
  ));
  return output;
}

function manifest(root, name, evidence) {
  return writeCanonical(join(root, name), {
    evidence: TASKS.map((taskId, index) => ({
      path: evidence[index],
      task_id: taskId
    })),
    source_commit: COMMIT
  });
}

test("target corpus admits measured observations and holds token proxies", async () => {
  const root = mkdtempSync(join(tmpdir(), "effectgate-target-corpus-"));
  try {
    const invalid = writeCanonical(join(root, "invalid.json"), {});
    await assert.rejects(
      runObservedBenchmark({
        input: invalid,
        output: join(root, "invalid.jsonl")
      }),
      /invalid benchmark observations/
    );
    assert.throws(
      () => qualifyTargetCorpus({ input: invalid }),
      /invalid target-corpus manifest/
    );

    const measured = [];
    const estimated = [];
    for (const taskId of TASKS) {
      measured.push(await observedEvidence(root, taskId, true, "measured"));
      estimated.push(await observedEvidence(root, taskId, false, "proxy"));
    }
    const passingManifest = manifest(root, "passing.json", measured);
    const passing = qualifyTargetCorpus({ input: passingManifest });
    assert.equal(passing.verdict, "pass");
    assert.equal(passing.source_commit, COMMIT);
    assert.equal(passing.tasks.length, 4);
    assert.equal(passing.measurements.total_input_reduction_median, 0.6);
    assert.ok(Object.values(passing.checks).every(Boolean));
    for (const task of passing.tasks) {
      assert.equal(task.verdict, "pass");
      assert.deepEqual(task.measurements, {
        additional_fetch_rate_upper: 0,
        first_view_reduction: 0.8,
        task_success_delta: 0,
        total_input_reduction: 0.6
      });
    }

    const cli = spawnSync(process.execPath, [
      PROGRAM, "--input", passingManifest
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(cli.status, 0, cli.stderr);
    assert.deepEqual(JSON.parse(cli.stdout), passing);

    const held = qualifyTargetCorpus({
      input: manifest(root, "held.json", estimated)
    });
    assert.equal(held.verdict, "fail");
    assert.equal(held.measurements.total_input_reduction_median, null);
    assert.equal(held.checks.h11_token_value, false);
    assert.equal(held.checks.p0_total_input_reduction, false);
    assert.ok(held.tasks.every(
      ({ checks }) => checks.total_input_reduction === false
    ));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
