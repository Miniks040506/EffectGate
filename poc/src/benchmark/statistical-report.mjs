#!/usr/bin/env node

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  BENCHMARK_PROFILES,
  SKILL_BENCHMARK_PROFILES,
  validateBenchmarkMetrics
} from "./paired-harness.mjs";
import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";

const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const TASK = /^BENCH-[A-Z0-9-]{1,64}$/u;
const ID = /^(?:pair|run)_[a-f0-9]{64}$/u;
const FAILURE = /^[a-z0-9][a-z0-9_.-]{0,63}$/u;
const HEADER_KEYS = [
  "kind", "schema_version", "task_id", "seed", "repetitions", "profiles",
  "backend_digest", "prompt_digest", "rubric_digest", "model", "effort",
  "host_version", "machine_class", "created_at"
];
const NUMERIC_METRICS = [
  "latency_ms", "fetch_count", "tool_call_count",
  "instruction_fetch_count", "protected_effect_policy_violations",
  "duplicate_write_count"
];
const BOOLEAN_METRICS = [
  "wrong_skill_selection", "wrong_phase_transition",
  "safety_invariant_available"
];
const TOKEN_METRICS = [
  "tool_schema_tokens", "tool_result_tokens", "total_input_tokens",
  "skill_catalog_tokens", "skill_instruction_tokens",
  "instruction_fetch_tokens", "phase_receipt_tokens",
  "verification_tokens"
];
// ponytail: fixed resamples keep reports reproducible; raise only by evidence policy.
const BOOTSTRAP_RESAMPLES = 2_000;
const MAX_EVIDENCE_BYTES = 64 * 1024 * 1024;
const USAGE =
  "Usage: statistical-report.mjs --input FILE --output FILE";

function bounded(value, maximum = 128) {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= maximum &&
    Buffer.byteLength(value, "utf8") <= maximum * 4 &&
    !value.includes("\0") && value === value.normalize("NFC");
}

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function timestamp(value) {
  try {
    return typeof value === "string" &&
      new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function round(value) {
  return Number(value.toFixed(6));
}

function quantile(sorted, probability) {
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * probability;
  const lower = Math.floor(position);
  const weight = position - lower;
  return round(
    sorted[lower] +
    (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) * weight
  );
}

function randomFrom(seed) {
  let state = createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0x1_0000_0000;
  };
}

function bootstrapInterval(values, seed, statistic) {
  if (values.length === 1) {
    const value = round(statistic(values));
    return {
      method: "percentile_bootstrap",
      resamples: BOOTSTRAP_RESAMPLES,
      lower: value,
      upper: value
    };
  }
  const random = randomFrom(seed);
  const estimates = Array.from({ length: BOOTSTRAP_RESAMPLES }, () => {
    const sample = Array.from(
      { length: values.length },
      () => values[Math.floor(random() * values.length)]
    );
    return statistic(sample);
  }).sort((left, right) => left - right);
  return {
    method: "percentile_bootstrap",
    resamples: BOOTSTRAP_RESAMPLES,
    lower: quantile(estimates, 0.025),
    upper: quantile(estimates, 0.975)
  };
}

function measurement(values, seed) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const median = (sample) =>
    quantile([...sample].sort((left, right) => left - right), 0.5);
  return {
    samples: values.length,
    median: quantile(sorted, 0.5),
    p95: quantile(sorted, 0.95),
    median_ci_95: bootstrapInterval(values, seed, median)
  };
}

function rate(values, seed) {
  if (values.length === 0) return null;
  const count = values.filter(Boolean).length;
  const average = (sample) =>
    round(sample.filter(Boolean).length / sample.length);
  return {
    samples: values.length,
    count,
    rate: round(count / values.length),
    confidence_interval_95:
      bootstrapInterval(values, seed, average)
  };
}

function profileKind(profiles) {
  if (!Array.isArray(profiles)) return undefined;
  const candidates = [
    ["effect", Object.keys(BENCHMARK_PROFILES)],
    ["skill", Object.keys(SKILL_BENCHMARK_PROFILES)]
  ];
  return candidates.find(([, expected]) =>
    canonicalJson(expected) === canonicalJson(profiles));
}

function validHeader(header) {
  const kind = profileKind(header?.profiles);
  return exact(header, HEADER_KEYS) &&
    header.kind === "effectgate_paired_benchmark" &&
    header.schema_version === "1.0.0" &&
    TASK.test(header.task_id ?? "") &&
    bounded(header.seed) &&
    Number.isSafeInteger(header.repetitions) &&
    header.repetitions >= 1 && header.repetitions <= 1_000 &&
    kind !== undefined &&
    [header.backend_digest, header.prompt_digest,
      header.rubric_digest].every((value) => DIGEST.test(value ?? "")) &&
    [header.model, header.host_version,
      header.machine_class].every((value) => bounded(value)) &&
    bounded(header.effort, 64) && timestamp(header.created_at)
      ? kind
      : undefined;
}

function readEvidence(file) {
  if (!bounded(file, 1024)) {
    throw new TypeError("invalid benchmark evidence file");
  }
  const evidenceFile = resolve(file);
  const bytes = fs.readFileSync(evidenceFile);
  if (bytes.length < 2 || bytes.length > MAX_EVIDENCE_BYTES ||
      bytes.at(-1) !== 0x0a) {
    throw new TypeError("invalid benchmark evidence");
  }
  let records;
  try {
    records = new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      .slice(0, -1).split("\n").map(
      (line) => JSON.parse(line)
    );
  } catch {
    throw new TypeError("invalid benchmark evidence");
  }
  const [header, ...rawEvents] = records;
  const profile = validHeader(header);
  if (!profile ||
      rawEvents.length !== header.repetitions * header.profiles.length) {
    throw new TypeError("invalid benchmark evidence");
  }
  const skillProfile = profile[0] === "skill";
  const events = rawEvents.map((event) => {
    const common = [
      "kind", "pair_id", "run_id", "task_id", "repetition",
      "order_index", "profile", "status", "observed_at"
    ];
    const keys = event?.status === "completed"
      ? [...common, "metrics"]
      : [...common, "failure_code"];
    const pairId = `pair_${sha256(
      `${header.task_id}\0${header.seed}\0${event?.repetition}`
    )}`;
    const runId = `run_${sha256(`${pairId}\0${event?.profile}`)}`;
    if (!exact(event, keys) || event.kind !== "run" ||
        !ID.test(event.pair_id ?? "") || !ID.test(event.run_id ?? "") ||
        event.pair_id !== pairId || event.run_id !== runId ||
        event.task_id !== header.task_id ||
        !Number.isSafeInteger(event.repetition) ||
        event.repetition < 0 || event.repetition >= header.repetitions ||
        !Number.isSafeInteger(event.order_index) ||
        event.order_index < 0 ||
        event.order_index >= header.profiles.length ||
        !header.profiles.includes(event.profile) ||
        !["completed", "failed"].includes(event.status) ||
        !timestamp(event.observed_at) ||
        Date.parse(event.observed_at) < Date.parse(header.created_at) ||
        (event.status === "failed" &&
          !FAILURE.test(event.failure_code ?? ""))) {
      throw new TypeError("invalid benchmark evidence");
    }
    if (event.status === "failed") return event;
    try {
      return {
        ...event,
        metrics: validateBenchmarkMetrics(event.metrics, { skillProfile })
      };
    } catch {
      throw new TypeError("invalid benchmark evidence");
    }
  });
  for (let repetition = 0; repetition < header.repetitions; repetition += 1) {
    const pair = events.filter((event) => event.repetition === repetition);
    if (new Set(pair.map(({ profile: id }) => id)).size !==
        header.profiles.length ||
        new Set(pair.map(({ order_index: index }) => index)).size !==
        header.profiles.length) {
      throw new TypeError("invalid benchmark evidence");
    }
  }
  return {
    bytes,
    header,
    events
  };
}
