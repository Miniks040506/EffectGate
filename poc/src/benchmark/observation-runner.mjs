#!/usr/bin/env node

import {
  lstatSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../skill/passport-compiler.mjs";
import {
  BENCHMARK_PROFILES,
  runPairedBenchmark,
  validateBenchmarkMetrics
} from "./paired-harness.mjs";

const COMMIT = /^[a-f0-9]{40}$/u;
const MAX_INPUT_BYTES = 16 * 1024 * 1024;
const PROFILE_IDS = Object.keys(BENCHMARK_PROFILES);
const TARGET_TASKS = new Set([
  "BENCH-READ-001",
  "BENCH-JSON-002",
  "BENCH-STREAM-003",
  "BENCH-TABLE-004"
]);
const USAGE = "Usage: observation-runner.mjs --input FILE --output FILE";

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function readCanonical(file) {
  const absolute = resolve(file);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_INPUT_BYTES) {
    throw new TypeError("invalid benchmark observation file");
  }
  const source = readFileSync(realpathSync(absolute), "utf8");
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new TypeError("invalid benchmark observation file");
  }
  if (source !== `${canonicalJson(value)}\n`) {
    throw new TypeError("benchmark observations must use canonical JSON");
  }
  return value;
}

function timestamp(value) {
  try {
    return typeof value === "string" && new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validateObservations(value) {
  const keys = [
    "kind", "schema_version", "source_commit", "task_id", "seed",
    "repetitions", "backend_digest", "prompt_digest", "rubric_digest",
    "model", "effort", "host_version", "machine_class", "observed_at",
    "runs"
  ];
  if (!exact(value, keys) ||
      value.kind !== "effectgate_benchmark_observations" ||
      value.schema_version !== "1.0.0" ||
      !COMMIT.test(value.source_commit ?? "") ||
      !TARGET_TASKS.has(value.task_id) ||
      !Number.isSafeInteger(value.repetitions) ||
      value.repetitions < 1 || value.repetitions > 1_000 ||
      !timestamp(value.observed_at) || !Array.isArray(value.runs) ||
      value.runs.length !== value.repetitions * PROFILE_IDS.length) {
    throw new TypeError("invalid benchmark observations");
  }
  const runs = new Map();
  for (const run of value.runs) {
    if (!exact(run, ["repetition", "profile", "metrics"]) ||
        !Number.isSafeInteger(run.repetition) || run.repetition < 0 ||
        run.repetition >= value.repetitions ||
        !PROFILE_IDS.includes(run.profile)) {
      throw new TypeError("invalid benchmark observations");
    }
    const key = `${run.repetition}\0${run.profile}`;
    if (runs.has(key)) throw new TypeError("duplicate benchmark observation");
    runs.set(key, validateBenchmarkMetrics(run.metrics));
  }
  return { value, runs };
}

export async function runObservedBenchmark({ input, output } = {}) {
  if (typeof input !== "string" || typeof output !== "string") {
    throw new TypeError("invalid benchmark observation configuration");
  }
  const { value, runs } = validateObservations(readCanonical(input));
  const benchmark = await runPairedBenchmark({
    file: output,
    taskId: value.task_id,
    seed: value.seed,
    repetitions: value.repetitions,
    backendDigest: value.backend_digest,
    promptDigest: value.prompt_digest,
    rubricDigest: value.rubric_digest,
    model: value.model,
    effort: value.effort,
    hostVersion: value.host_version,
    machineClass: value.machine_class,
    now: () => Date.parse(value.observed_at),
    runProfile: ({ repetition, profile }) =>
      runs.get(`${repetition}\0${profile}`)
  });
  return Object.freeze({
    source_commit: value.source_commit,
    benchmark
  });
}

function parseArguments(args) {
  if (args.length !== 4) throw new Error(USAGE);
  const values = Object.fromEntries([
    [args[0], args[1]],
    [args[2], args[3]]
  ]);
  if (Object.keys(values).length !== 2 || values["--input"] === undefined ||
      values["--output"] === undefined) throw new Error(USAGE);
  return { input: values["--input"], output: values["--output"] };
}

export async function main(args = process.argv.slice(2)) {
  const result = await runObservedBenchmark(parseArguments(args));
  const completed = result.benchmark.events.filter(
    ({ status }) => status === "completed"
  ).length;
  process.stdout.write(`${canonicalJson({
    completed_runs: completed,
    evidence_file: result.benchmark.file,
    failed_runs: result.benchmark.events.length - completed,
    source_commit: result.source_commit
  })}\n`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[effectgate-observations] ${error.message}\n`);
    process.exitCode = 2;
  });
}
