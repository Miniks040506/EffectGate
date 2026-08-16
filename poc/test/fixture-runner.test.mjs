import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { runFixtureBenchmark } from "../src/benchmark/fixture-runner.mjs";

const RUNNER = fileURLToPath(
  new URL("../src/benchmark/fixture-runner.mjs", import.meta.url)
);

test("fixture benchmark runs all four real profile paths with joined ledgers", async () => {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-fixture-bench-"));
  const output = join(directory, "paired.jsonl");
  const ledgerDirectory = join(directory, "ledgers");
  try {
    const result = await runFixtureBenchmark({
      output,
      ledgerDirectory,
      repetitions: 1,
      seed: "fixture-adapter-test"
    });
    assert.equal(result.events.length, 4);
    const byProfile = Object.fromEntries(
      result.events.map((event) => [event.profile, event])
    );

    for (const profile of [
      "P0_NATIVE_DEFAULT",
      "P1_EG_TYPED",
      "P2_EG_MUX",
      "P3_EAGER_DIAGNOSTIC"
    ]) {
      const event = byProfile[profile];
      assert.equal(event.status, "completed");
      assert.equal(event.metrics.task_success, true);
      assert.ok(event.metrics.latency_ms > 0);
      assert.equal(event.metrics.fetch_count, 0);
      assert.equal(
        event.metrics.tool_call_count,
        profile === "P2_EG_MUX" ? 3 : 1
      );
      assert.equal(event.metrics.total_input_tokens, undefined);
      assert.equal(event.metrics.tool_schema_tokens.basis, "byte_proxy");
      assert.equal(event.metrics.tool_result_tokens.basis, "byte_proxy");
      assert.equal(
        event.metrics.compatibility.native_deferral,
        profile === "P1_EG_TYPED"
          ? "evidence_not_configured"
          : profile === "P2_EG_MUX"
            ? "profile_not_native_deferred"
            : "not_applicable"
      );
    }
    assert.ok(
      byProfile.P3_EAGER_DIAGNOSTIC.metrics.tool_schema_tokens.value >
        byProfile.P0_NATIVE_DEFAULT.metrics.tool_schema_tokens.value
    );
    const ledgers = readdirSync(ledgerDirectory);
    assert.equal(ledgers.length, 2);
    const ledgerRecords = ledgers.map((file) =>
      readFileSync(join(ledgerDirectory, file), "utf8")
        .trimEnd()
        .split("\n")
        .map(JSON.parse)
    );
    const typedLedger = ledgerRecords.find(
      ([header]) => header.profile === "native_deferred"
    );
    const compactLedger = ledgerRecords.find(
      ([header]) => header.profile === "compact_mux"
    );
    assert.equal(typedLedger[0].run_id, byProfile.P1_EG_TYPED.run_id);
    assert.deepEqual(
      typedLedger.slice(1).map(({ stage }) => stage),
      ["tool_metadata", "backend_raw_result", "first_view"]
    );
    assert.equal(compactLedger[0].run_id, byProfile.P2_EG_MUX.run_id);
    assert.deepEqual(
      compactLedger.slice(1).map(({ stage }) => stage),
      [
        "tool_metadata",
        "tool_metadata",
        "tool_metadata",
        "backend_raw_result",
        "first_view"
      ]
    );

    const evidence = readFileSync(output, "utf8")
      .trimEnd()
      .split("\n")
      .map(JSON.parse);
    assert.deepEqual(evidence, [result.header, ...result.events]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("fixture benchmark CLI writes evidence and a machine-readable summary", () => {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-fixture-cli-"));
  const output = join(directory, "paired.jsonl");
  try {
    const run = spawnSync(
      process.execPath,
      [
        RUNNER,
        "--output",
        output,
        "--ledger-directory",
        join(directory, "ledgers"),
        "--repetitions",
        "1"
      ],
      { encoding: "utf8", timeout: 10_000, windowsHide: true }
    );
    assert.equal(run.status, 0, run.stderr);
    assert.equal(run.stderr, "");
    assert.deepEqual(JSON.parse(run.stdout), {
      evidence_file: output,
      completed_runs: 4,
      failed_runs: 0
    });
    assert.equal(readFileSync(output, "utf8").split("\n").length, 6);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
