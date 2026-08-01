import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
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
const TIER1_EVIDENCE = fileURLToPath(new URL(
  "../evidence/tier1-performance-6c898e2.json", import.meta.url
));
const SHA256 = /^sha256:[a-f0-9]{64}$/u;

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

function latencyProfile(file, {
  machineClass = "fixture-machine",
  samples = 30,
  addedMedian = 0.9,
  addedP95 = 1.9
} = {}) {
  writeFileSync(file, JSON.stringify({
    kind: "effectgate_proxy_latency_profile",
    schema_version: "1.0.0",
    machine_class: machineClass,
    samples,
    small_read: {
      added_median_ms: addedMedian,
      added_p95_ms: addedP95
    }
  }));
}

test("small-read gate passes targets and fails regressions", async () => {
  const root = mkdtempSync(join(tmpdir(), "effectgate-performance-gate-"));
  try {
    const passingFile = join(root, "passing.jsonl");
    const passingProfile = join(root, "passing-profile.json");
    await benchmark(passingFile, 30, 130);
    latencyProfile(passingProfile);
    const passing = qualifySmallReadPerformance({
      file: passingFile,
      latencyProfileFile: passingProfile
    });
    assert.equal(passing.verdict, "pass");
    assert.deepEqual(passing.checks, {
      minimum_repetitions: true,
      minimum_latency_profile_samples: true,
      complete_profile_evidence: true,
      task_success_delta: true,
      matching_machine_class: true,
      proxy_added_median_latency: true,
      proxy_added_p95_latency: true
    });
    assert.equal(
      passing.measurements.typed_median_latency_overhead,
      0.3
    );
    assert.equal(passing.measurements.proxy_added_median_latency_ms, 0.9);
    assert.equal(passing.measurements.proxy_added_p95_latency_ms, 1.9);

    const failingFile = join(root, "failing.jsonl");
    const failingProfile = join(root, "failing-profile.json");
    await benchmark(failingFile, 10, 130);
    latencyProfile(failingProfile, {
      machineClass: "different-machine",
      samples: 10,
      addedMedian: 1.1,
      addedP95: 2.1
    });
    const failing = qualifySmallReadPerformance({
      file: failingFile,
      latencyProfileFile: failingProfile
    });
    assert.equal(failing.verdict, "fail");
    assert.equal(failing.checks.minimum_repetitions, false);
    assert.equal(failing.checks.minimum_latency_profile_samples, false);
    assert.equal(failing.checks.matching_machine_class, false);
    assert.equal(failing.checks.proxy_added_median_latency, false);
    assert.equal(failing.checks.proxy_added_p95_latency, false);

    const cli = spawnSync(process.execPath, [
      PROGRAM,
      "--input",
      failingFile,
      "--latency-profile",
      failingProfile
    ], { encoding: "utf8", windowsHide: true });
    assert.equal(cli.status, 1, cli.stderr);
    assert.equal(cli.stderr, "");
    assert.equal(JSON.parse(cli.stdout).verdict, "fail");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("EG-047 retains exact-commit Tier-1 performance evidence", () => {
  const evidence = JSON.parse(readFileSync(TIER1_EVIDENCE, "utf8"));
  assert.equal(evidence.task_id, "EG-047");
  assert.equal(evidence.evidence_state, "pass");
  assert.equal(
    evidence.source.qualified_commit_sha,
    "6c898e2da60944423b5fe7878e51fad192398ab8"
  );
  assert.equal(evidence.source.workflow_run_id, 30704911679);
  assert.deepEqual(
    evidence.platforms.map(({ id }) => id),
    ["linux-x64", "linux-arm64", "windows-x64", "macos-arm64"]
  );
  const artifactDigests = new Set();
  for (const platform of evidence.platforms) {
    assert.equal(platform.verdict, "pass");
    assert.equal(platform.repetitions, 100);
    assert.equal(platform.latency_profile_samples, 100);
    assert.equal(platform.task_success_rate, 1);
    assert.ok(
      platform.proxy_added_median_latency_ms <=
        evidence.thresholds.maximum_proxy_added_median_latency_ms
    );
    assert.ok(
      platform.proxy_added_p95_latency_ms <=
        evidence.thresholds.maximum_proxy_added_p95_latency_ms
    );
    assert.match(platform.qualification_evidence_digest, SHA256);
    assert.match(platform.artifact.digest, SHA256);
    assert.match(
      platform.artifact.name,
      new RegExp(evidence.source.qualified_commit_sha + "$", "u")
    );
    artifactDigests.add(platform.artifact.digest);
  }
  assert.equal(artifactDigests.size, 4);
  assert.deepEqual(evidence.sign_off, {
    decision: "pass",
    basis: "all_tier1_cells_passed",
    automated: true,
    human_release_approval_required: true
  });
});
