#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstatSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { basename, dirname, resolve } from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";
import { fileURLToPath } from "node:url";

import {
  RELEASE_EVIDENCE_GATES,
  compileReleaseCandidate
} from "./release-candidate.mjs";
import { canonicalJson } from "../skill/passport-compiler.mjs";

const COMMIT = /^[a-f0-9]{40}$/u;
const KIND = /^effectgate_[a-z0-9_]+$/u;
const MAX_EVIDENCE_BYTES = 16 * 1024 * 1024;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const USAGE = "Usage: release-evidence.mjs --input FILE";
const UTF8 = new TextDecoder("utf-8", { fatal: true });

function exactObject(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function readJson(file, canonical = false) {
  const absolute = resolve(file);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.size < 2 || stat.size > MAX_EVIDENCE_BYTES) {
    throw new Error("release evidence must be a bounded regular file");
  }
  const path = realpathSync(absolute);
  const bytes = readFileSync(path);
  let source;
  let value;
  try {
    source = UTF8.decode(bytes);
    value = JSON.parse(source);
  } catch {
    throw new Error("release evidence must be valid UTF-8 JSON");
  }
  if (canonical && source !== `${canonicalJson(value)}\n`) {
    throw new Error("release evidence must use canonical JSON");
  }
  return { path, bytes, value };
}

function validGateEvidence(value, gate, sourceCommit) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    KIND.test(value.kind ?? "") && value.schema_version === "1.0.0" &&
    value.gate === gate && value.source_commit === sourceCommit &&
    value.verdict === "pass";
}

export function compileReleaseCandidateFromFiles({ input } = {}) {
  if (typeof input !== "string" || input.length < 1 || input.includes("\0")) {
    throw new TypeError("invalid release evidence input");
  }
  const manifestFile = readJson(input);
  const manifest = manifestFile.value;
  if (!exactObject(manifest, ["release_qualification", "evidence"]) ||
      typeof manifest.release_qualification !== "string" ||
      !Array.isArray(manifest.evidence) ||
      manifest.evidence.length !== RELEASE_EVIDENCE_GATES.length ||
      manifest.evidence.some((entry) => !exactObject(entry, ["gate", "path"]) ||
        !RELEASE_EVIDENCE_GATES.includes(entry.gate) ||
        typeof entry.path !== "string" || entry.path.length < 1 ||
        entry.path.includes("\0")) ||
      canonicalJson(manifest.evidence.map(({ gate }) => gate).sort()) !==
        canonicalJson(RELEASE_EVIDENCE_GATES)) {
    throw new TypeError("invalid release evidence manifest");
  }
  const root = dirname(manifestFile.path);
  const qualificationFile = readJson(
    resolve(root, manifest.release_qualification),
    true
  );
  const qualification = qualificationFile.value;
  if (!COMMIT.test(qualification?.source_commit ?? "")) {
    throw new Error("release qualification is not source-bound");
  }
  const admitted = manifest.evidence.map(({ gate, path }) => {
    const file = readJson(resolve(root, path), true);
    if (gate === "release_reproducibility"
      ? file.path !== qualificationFile.path ||
        file.value.kind !== "effectgate_release_qualification"
      : !validGateEvidence(file.value, gate, qualification.source_commit)) {
      throw new Error("release evidence must be a source-bound pass");
    }
    return {
      path: file.path,
      gate,
      source_commit: qualification.source_commit,
      artifact_name: basename(file.path),
      artifact_digest: `sha256:${createHash("sha256")
        .update(file.bytes).digest("hex")}`,
      verdict: "pass"
    };
  });
  if (new Set(admitted.map(({ path }) => path)).size !== admitted.length ||
      new Set(admitted.map(({ artifact_name: name }) => name)).size !==
        admitted.length ||
      admitted.some(({ artifact_name: name }) => !NAME.test(name))) {
    throw new Error("release evidence files must be unique and safely named");
  }
  return compileReleaseCandidate({
    releaseQualification: qualification,
    evidence: admitted.map(({ path: ignored, ...entry }) => entry)
  });
}

export function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--input") throw new Error(USAGE);
  const candidate = compileReleaseCandidateFromFiles({ input: args[1] });
  process.stdout.write(`${canonicalJson(candidate)}\n`);
  return candidate;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`[effectgate-release-evidence] ${error.message}\n`);
    process.exitCode = 1;
  }
}
