import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BENCHMARK_PROFILES,
  runPairedBenchmark
} from "../src/benchmark/paired-harness.mjs";
import {
  generateBenchmarkReport,
  writeBenchmarkReport
} from "../src/benchmark/statistical-report.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRAM = fileURLToPath(new URL(
  "../src/benchmark/statistical-report.mjs", import.meta.url
));
const CONTRACT = JSON.parse(readFileSync(join(
  HERE, "..", "..", "contracts", "benchmark-report.schema.json"
), "utf8"));

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-report-"));
  return {
    directory,
    evidence: join(directory, "evidence.jsonl"),
    output: join(directory, "report.json"),
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

function metrics(context) {
  const value = (context.repetition + 1) * 10;
  return {
    task_success: context.profile !== "P3_EAGER_DIAGNOSTIC",
    latency_ms: value,
    fetch_count: context.profile === "P1_EG_TYPED" ? 1 : 0,
    tool_call_count: context.profile === "P2_EG_MUX" ? 3 : 1,
    tool_schema_tokens: count(
      value + 1, "byte_proxy", "utf8-bytes-ceil-div-4"
    ),
    tool_result_tokens: count(
      value + 2, "byte_proxy", "utf8-bytes-ceil-div-4"
    ),
    total_input_tokens: count(
      value + 3, "host_reported", "fixture-host-usage"
    ),
    compatibility: { native_deferral: "not_applicable" }
  };
}

function benchmark(file, repetitions = 4) {
  return runPairedBenchmark({
    file,
    taskId: "BENCH-READ-001",
    seed: "report-seed-v1",
    repetitions,
    backendDigest: digest("backend"),
    promptDigest: digest("prompt"),
    rubricDigest: digest("rubric"),
    model: "fixture-model",
    effort: "none",
    hostVersion: "fixture-host-1",
    machineClass: "fixture-machine",
    now: () => Date.parse("2026-07-28T00:00:00.000Z"),
    runProfile(context) {
      if (context.repetition === 1 && context.profile === "P2_EG_MUX") {
        const error = new Error("secret failure detail");
        error.code = "backend_timeout";
        throw error;
      }
      return metrics(context);
    }
  });
}

function profile(report, id) {
  return report.profile_reports.find(({ profile: value }) => value === id);
}

function measurement(report, metric, basis = "runtime") {
  return report.measurements.find((value) =>
    value.metric === metric && value.basis === basis);
}

function rate(report, metric) {
  return report.rates.find((value) => value.metric === metric).summary;
}

function assertKeys(value, schema) {
  assert.deepEqual(
    Object.keys(value).sort(),
    schema.required.toSorted()
  );
}

function assertContract(report) {
  assertKeys(report, CONTRACT);
  assert.equal(report.kind, CONTRACT.properties.kind.const);
  assert.equal(report.schema_version, CONTRACT.properties.schema_version.const);
  assert.match(
    report.evidence_digest,
    new RegExp(CONTRACT.$defs.digest.pattern, "u")
  );
  for (const value of report.profile_reports) {
    assertKeys(value, CONTRACT.$defs.profile_report);
    for (const failure of value.failures) {
      assertKeys(failure, CONTRACT.$defs.failure);
    }
    for (const compatibility of value.compatibility) {
      assertKeys(compatibility, CONTRACT.$defs.compatibility);
    }
    for (const item of value.rates) {
      assertKeys(item, CONTRACT.$defs.rate);
      assertKeys(item.summary, CONTRACT.$defs.rate_summary);
      assertKeys(
        item.summary.confidence_interval_95,
        CONTRACT.$defs.interval
      );
    }
    for (const item of value.measurements) {
      assertKeys(item, CONTRACT.$defs.measurement);
      assertKeys(item.summary, CONTRACT.$defs.measurement_summary);
      assertKeys(item.summary.median_ci_95, CONTRACT.$defs.interval);
    }
  }
}

test("statistical report retains failures and deterministic measurements", async () => {
  const files = fixture();
  try {
    await benchmark(files.evidence);
    const first = generateBenchmarkReport({ file: files.evidence });
    const second = generateBenchmarkReport({ file: files.evidence });
    assert.deepEqual(first, second);
    assert.equal(Object.isFrozen(first), true);
    assertContract(first);
    assert.equal(first.total_runs, 16);
    assert.equal(first.completed_runs, 15);
    assert.equal(first.failed_runs, 1);
    assert.equal(first.minimum_repetitions, 30);
    assert.equal(first.minimum_repetitions_met, false);

    const native = profile(first, "P0_NATIVE_DEFAULT");
    const latency = measurement(native, "latency_ms").summary;
    assert.deepEqual(
      { samples: latency.samples, median: latency.median, p95: latency.p95 },
      { samples: 4, median: 25, p95: 38.5 }
    );
    assert.equal(latency.median_ci_95.method, "percentile_bootstrap");
    assert.equal(latency.median_ci_95.resamples, 2000);
    assert.ok(latency.median_ci_95.lower <= latency.median);
    assert.ok(latency.median_ci_95.upper >= latency.median);
    assert.deepEqual(rate(native, "task_success"), {
      samples: 4,
      count: 4,
      rate: 1,
      confidence_interval_95: {
        method: "percentile_bootstrap",
        resamples: 2000,
        lower: 1,
        upper: 1
      }
    });

    const mux = profile(first, "P2_EG_MUX");
    assert.equal(mux.completed_runs, 3);
    assert.equal(mux.failed_runs, 1);
    assert.deepEqual(mux.failures, [{
      failure_code: "backend_timeout",
      count: 1
    }]);
    assert.equal(rate(mux, "task_success").samples, 4);
    assert.equal(rate(mux, "task_success").count, 3);
    const typed = profile(first, "P1_EG_TYPED");
    assert.equal(rate(typed, "fetch_required").rate, 1);
    assert.equal(
      measurement(typed, "tool_schema_tokens", "byte_proxy")
        .counter_id,
      "utf8-bytes-ceil-div-4"
    );
    assert.equal(
      measurement(typed, "total_input_tokens", "host_reported")
        .counter_id,
      "fixture-host-usage"
    );

    const written = writeBenchmarkReport({
      input: files.evidence,
      output: files.output
    });
    assert.deepEqual(
      JSON.parse(readFileSync(written.file, "utf8")),
      first
    );
    assert.throws(() => writeBenchmarkReport({
      input: files.evidence,
      output: files.output
    }), { code: "EEXIST" });
  } finally {
    files.close();
  }
});

test("report CLI writes summary and evidence validation fails closed", async () => {
  const files = fixture();
  try {
    await benchmark(files.evidence, 2);
    const cliOutput = join(files.directory, "cli-report.json");
    const run = spawnSync(process.execPath, [
      PROGRAM,
      "--input",
      files.evidence,
      "--output",
      cliOutput
    ], { encoding: "utf8" });
    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(JSON.parse(run.stdout), {
      report_file: cliOutput,
      completed_runs: 7,
      failed_runs: 1,
      minimum_repetitions_met: false
    });

    const records = readFileSync(files.evidence, "utf8")
      .trimEnd().split("\n").map(JSON.parse);
    const mutations = [
      (copy) => { copy[1].pair_id = `pair_${"0".repeat(64)}`; },
      (copy) => { copy[1].metrics.latency_ms = -1; },
      (copy) => { copy[1].unexpected = "unsafe"; },
      (copy) => { copy.push(copy[1]); }
    ];
    for (const [index, mutate] of mutations.entries()) {
      const copy = structuredClone(records);
      mutate(copy);
      const file = join(files.directory, `corrupt-${index}.jsonl`);
      writeFileSync(file, `${copy.map(JSON.stringify).join("\n")}\n`);
      assert.throws(
        () => generateBenchmarkReport({ file }),
        { name: "TypeError", message: "invalid benchmark evidence" }
      );
    }
    const truncated = join(files.directory, "truncated.jsonl");
    writeFileSync(truncated, records.map(JSON.stringify).join("\n"));
    assert.throws(
      () => generateBenchmarkReport({ file: truncated }),
      { name: "TypeError", message: "invalid benchmark evidence" }
    );
  } finally {
    files.close();
  }
});
