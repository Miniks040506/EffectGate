#!/usr/bin/env node

import * as fs from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { generateExposureRecommendation } from "./exposure-recommender.mjs";
import { canonicalJson } from "../skill/passport-compiler.mjs";

const USAGE =
  "Usage: exposure-recommendation-cli.mjs --evidence FILE --output FILE";

function bounded(value, maximum = 1024) {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= maximum &&
    Buffer.byteLength(value, "utf8") <= maximum * 4 &&
    !value.includes("\0") && value === value.normalize("NFC");
}

export function writeExposureRecommendation({
  evidenceFile, output
} = {}) {
  if (!bounded(output)) {
    throw new TypeError("invalid exposure recommendation output");
  }
  const recommendation = generateExposureRecommendation({ evidenceFile });
  const outputFile = resolve(output);
  fs.mkdirSync(dirname(outputFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(outputFile, `${canonicalJson(recommendation)}\n`, {
    flag: "wx",
    encoding: "utf8",
    mode: 0o600,
    flush: true
  });
  return Object.freeze({ file: outputFile, recommendation });
}

function parseArguments(args) {
  if (args.length !== 4) throw new Error(USAGE);
  const values = Object.fromEntries([
    [args[0], args[1]],
    [args[2], args[3]]
  ]);
  if (Object.keys(values).length !== 2 ||
      values["--evidence"] === undefined ||
      values["--output"] === undefined) {
    throw new Error(USAGE);
  }
  return {
    evidenceFile: values["--evidence"],
    output: values["--output"]
  };
}

export function main(args = process.argv.slice(2)) {
  const result = writeExposureRecommendation(parseArguments(args));
  process.stdout.write(`${JSON.stringify({
    recommendation_file: result.file,
    status: result.recommendation.status,
    suggested_profile: result.recommendation.suggested_profile,
    review_required: result.recommendation.review_required
  })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[effectgate-recommend] ${error.message}\n`);
    process.exitCode = 2;
  }
}
