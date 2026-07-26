#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { arch, platform } from "node:os";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { EFFECTGATE_VERSION } from "../proxy/effectgate.mjs";
import { runFixtureProfile, SMALL_READ_PAYLOAD } from "./fixture-profile.mjs";
import { runPairedBenchmark } from "./paired-harness.mjs";

const PROXY_FILE = fileURLToPath(
  new URL("../proxy/effectgate.mjs", import.meta.url)
);
const USAGE =
  "Usage: fixture-runner.mjs --output FILE --ledger-directory DIRECTORY " +
  "[--repetitions COUNT] [--seed VALUE]";

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function parseArguments(args) {
  let output;
  let ledgerDirectory;
  let repetitions = 1;
  let seed = "effectgate-small-read-v1";
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new Error(USAGE);
    if (option === "--output") {
      output = value;
    } else if (option === "--ledger-directory") {
      ledgerDirectory = value;
    } else if (
      option === "--repetitions" &&
      /^[1-9]\d{0,3}$/u.test(value) &&
      Number(value) <= 1_000
    ) {
      repetitions = Number(value);
    } else if (
      option === "--seed" &&
      value.length >= 1 &&
      value.length <= 128 &&
      Buffer.byteLength(value, "utf8") <= 512 &&
      !value.includes("\0")
    ) {
      seed = value;
    } else {
      throw new Error(USAGE);
    }
  }
  if (output === undefined || ledgerDirectory === undefined) {
    throw new Error(USAGE);
  }
  return { output, ledgerDirectory, repetitions, seed };
}

export function runFixtureBenchmark({
  output,
  ledgerDirectory,
  repetitions = 1,
  seed = "effectgate-small-read-v1"
}) {
  return runPairedBenchmark({
    file: output,
    taskId: "BENCH-SMALL-005",
    seed,
    repetitions,
    backendDigest: digest(readFileSync(PROXY_FILE)),
    promptDigest: digest(SMALL_READ_PAYLOAD),
    rubricDigest: digest("exact structuredContent.text match"),
    model: "deterministic-fixture",
    effort: "none",
    hostVersion: `effectgate-fixture-${EFFECTGATE_VERSION}`,
    machineClass: `${platform()}-${arch()}`,
    runProfile: (context) =>
      runFixtureProfile(context, { ledgerDirectory })
  });
}

export async function main(args = process.argv.slice(2)) {
  const result = await runFixtureBenchmark(parseArguments(args));
  const completed = result.events.filter(
    ({ status }) => status === "completed"
  ).length;
  process.stdout.write(`${JSON.stringify({
    evidence_file: result.file,
    completed_runs: completed,
    failed_runs: result.events.length - completed
  })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[effectgate-benchmark] ${error.message}\n`);
    process.exitCode = 2;
  });
}
