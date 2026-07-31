import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  qualifySmallReadPerformance
} from "../src/benchmark/performance-gate.mjs";
import { runPairedBenchmark } from "../src/benchmark/paired-harness.mjs";

const PROGRAM = fileURLToPath(new URL(
  "../src/benchmark/performance-gate.mjs", import.meta.url
));

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function count(value) {
  return {
    value,
    basis: "byte_proxy",
    counter_id: "utf8-bytes-ceil-div-4",
    counter_version: "1",
    input_digest: digest(String(value))
  };
}

function benchmark(file, repetitions, typedLatency) {
  return runPairedBenchmark({
    file,
    taskId: "BENCH-SMALL-005",
    seed: "performance-gate-test",
    repetitions,
    backendDigest: digest("backend"),
    promptDigest: digest("prompt"),
    rubricDigest: digest("rubric"),
    model: "deterministic-fixture",
    effort: "none",
    hostVersion: "fixture-host-1",
    machineClass: "fixture-machine",
    now: () => Date.parse("2026-07-31T00:00:00.000Z"),
    runProfile({ profile }) {
      const latency = profile === "P1_EG_TYPED" ? typedLatency : 100;
      return {
        task_success: true,
        latency_ms: latency,
        fetch_count: 0,
        tool_call_count: profile === "P2_EG_MUX" ? 3 : 1,
        tool_schema_tokens: count(10),
        tool_result_tokens: count(20),
        compatibility: { native_deferral: "not_applicable" }
      };
    }
  });
}

test("small-read gate passes targets and fails regressions", async () => {
  const root = mkdtempSync(join(tmpdir(), "effectgate-performance-gate-"));
  try {
    const passingFile = join(root, "passing.jsonl");
    await benchmark(passingFile, 30, 110);
    const passing = qualifySmallReadPerformance({ file: passingFile });
    assert.equal(passing.verdict, "pass");
    assert.deepEqual(passing.checks, {
      minimum_repetitions: true,
      complete_profile_evidence: true,
      task_success_delta: true,
      typed_median_latency_overhead: true
    });
    assert.equal(
      passing.measurements.typed_median_latency_overhead,
      0.1
    );
    assert.equal(passing.measurements.typed_added_median_latency_ms, 10);

    const failingFile = join(root, "failing.jsonl");
    await benchmark(failingFile, 10, 130);
    const failing = qualifySmallReadPerformance({ file: failingFile });
    assert.equal(failing.verdict, "fail");
    assert.equal(failing.checks.minimum_repetitions, false);
    assert.equal(failing.checks.typed_median_latency_overhead, false);
    assert.equal(failing.measurements.typed_median_latency_overhead, 0.3);

    const cli = spawnSync(process.execPath, [PROGRAM, "--input", failingFile], {
      encoding: "utf8",
      windowsHide: true
    });
    assert.equal(cli.status, 1, cli.stderr);
    assert.equal(cli.stderr, "");
    assert.equal(JSON.parse(cli.stdout).verdict, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
