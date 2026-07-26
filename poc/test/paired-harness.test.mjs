import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  BENCHMARK_PROFILES,
  runPairedBenchmark
} from "../src/benchmark/paired-harness.mjs";

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-benchmark-test-"));
  const base = {
    taskId: "BENCH-READ-001",
    seed: "seeded-fixture-v1",
    repetitions: 2,
    backendDigest: digest("same backend bytes"),
    promptDigest: digest("same task prompt"),
    rubricDigest: digest("same success rubric"),
    model: "fixture-model",
    effort: "fixture-effort",
    hostVersion: "fixture-host-1",
    machineClass: "fixture-machine",
    now: () => Date.parse("2026-07-26T00:00:00.000Z")
  };
  return {
    directory,
    base,
    close() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

function metrics(inputDigest, profile) {
  return {
    task_success: profile !== "P3_EAGER_DIAGNOSTIC",
    latency_ms: 10.5,
    fetch_count: profile === "P1_EG_TYPED" ? 1 : 0,
    tool_call_count: 1,
    tool_schema_tokens: {
      value: 20,
      basis: "byte_proxy",
      counter_id: "utf8-bytes-ceil-div-4",
      counter_version: "1",
      input_digest: inputDigest
    },
    tool_result_tokens: {
      value: 30,
      basis: "byte_proxy",
      counter_id: "utf8-bytes-ceil-div-4",
      counter_version: "1",
      input_digest: inputDigest
    },
    compatibility: {
      native_deferral: "not_applicable"
    },
    total_input_tokens: {
      value: 100,
      basis: "host_reported",
      counter_id: "fixture-host-usage",
      counter_version: "1",
      input_digest: inputDigest
    }
  };
}

test("paired harness deterministically runs every profile and retains failures", async () => {
  const files = fixture();
  const secret = "secret runner detail must not persist";
  try {
    const run = async (file) =>
      runPairedBenchmark({
        ...files.base,
        file,
        async runProfile(context) {
          assert.equal(Object.isFrozen(context), true);
          assert.equal(
            context.ledgerProfile,
            BENCHMARK_PROFILES[context.profile]
          );
          if (
            context.repetition === 0 &&
            context.profile === "P2_EG_MUX"
          ) {
            const error = new Error(secret);
            error.code = "backend_timeout";
            throw error;
          }
          return metrics(files.base.promptDigest, context.profile);
        }
      });

    const first = await run(join(files.directory, "first.jsonl"));
    const second = await run(join(files.directory, "second.jsonl"));
    assert.deepEqual(first.header, second.header);
    assert.deepEqual(first.events, second.events);
    assert.equal(first.events.length, 8);
    assert.equal(new Set(first.events.map(({ run_id }) => run_id)).size, 8);
    assert.equal(new Set(first.events.map(({ pair_id }) => pair_id)).size, 2);

    for (let repetition = 0; repetition < 2; repetition += 1) {
      const paired = first.events.filter(
        (event) => event.repetition === repetition
      );
      assert.deepEqual(
        new Set(paired.map(({ profile }) => profile)),
        new Set(Object.keys(BENCHMARK_PROFILES))
      );
      assert.deepEqual(
        paired.map(({ order_index }) => order_index),
        [0, 1, 2, 3]
      );
    }

    const failed = first.events.find(({ status }) => status === "failed");
    assert.equal(failed.profile, "P2_EG_MUX");
    assert.equal(failed.failure_code, "backend_timeout");
    const text = readFileSync(first.file, "utf8");
    assert.equal(text.includes(secret), false);
    const records = text.trimEnd().split("\n").map(JSON.parse);
    assert.deepEqual(records, [first.header, ...first.events]);
  } finally {
    files.close();
  }
});

test("paired harness rejects invalid metrics and never overwrites evidence", async () => {
  const files = fixture();
  const file = join(files.directory, "evidence.jsonl");
  try {
    const result = await runPairedBenchmark({
      ...files.base,
      file,
      repetitions: 1,
      runProfile() {
        return { task_success: true };
      }
    });
    assert.equal(result.events.length, 4);
    assert.deepEqual(
      result.events.map(({ status, failure_code }) => [
        status,
        failure_code
      ]),
      Array.from({ length: 4 }, () => ["failed", "invalid_result"])
    );
    await assert.rejects(
      runPairedBenchmark({
        ...files.base,
        file,
        repetitions: 1,
        runProfile() {
          return metrics(files.base.promptDigest, "P0_NATIVE_DEFAULT");
        }
      }),
      { code: "EEXIST" }
    );
  } finally {
    files.close();
  }
});
