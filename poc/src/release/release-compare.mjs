#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";

const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const USAGE =
  "Usage: release-compare.mjs --input DIRECTORY --source-commit SHA";

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

function inspectBundle(directory, sourceCommit) {
  const provenanceFile = join(directory, "provenance.json");
  let provenance;
  try {
    provenance = JSON.parse(readFileSync(provenanceFile, "utf8"));
  } catch {
    throw new Error("release bundle has invalid provenance");
  }
  const filename = provenance.subject?.filename;
  if (
    provenance.kind !== "effectgate_release_provenance" ||
    provenance.schema_version !== "1.0.0" ||
    provenance.source?.commit_sha !== sourceCommit ||
    !NAME.test(provenance.subject?.name ?? "") ||
    !VERSION.test(provenance.subject?.version ?? "") ||
    provenance.subject?.license !== "Apache-2.0" ||
    typeof filename !== "string" ||
    basename(filename) !== filename ||
    !/^[A-Za-z0-9._-]+\.tgz$/u.test(filename) ||
    !SHA256.test(provenance.subject?.sha256 ?? "") ||
    provenance.sbom?.filename !== "sbom.cdx.json" ||
    !SHA256.test(provenance.sbom?.sha256 ?? "")
  ) {
    throw new Error("release bundle provenance does not match source");
  }
  const expectedFiles = [
    "SHA256SUMS",
    filename,
    "provenance.json",
    "sbom.cdx.json"
  ].sort();
  const entries = readdirSync(directory, { withFileTypes: true });
  if (
    entries.some((entry) => !entry.isFile()) ||
    canonicalJson(entries.map(({ name }) => name).sort()) !==
      canonicalJson(expectedFiles)
  ) {
    throw new Error("release bundle has unexpected contents");
  }
  const tarball = join(directory, filename);
  const digests = {
    tarball_sha256: `sha256:${sha256(tarball)}`,
    sbom_sha256: `sha256:${sha256(join(directory, "sbom.cdx.json"))}`,
    provenance_sha256: `sha256:${sha256(provenanceFile)}`
  };
  const checksumManifest =
    `${digests.tarball_sha256.slice(7)}  ${filename}\n` +
    `${digests.sbom_sha256.slice(7)}  sbom.cdx.json\n` +
    `${digests.provenance_sha256.slice(7)}  provenance.json\n`;
  if (
    provenance.subject.sha256 !== digests.tarball_sha256 ||
    provenance.subject.size_bytes !== statSync(tarball).size ||
    provenance.sbom.sha256 !== digests.sbom_sha256 ||
    readFileSync(join(directory, "SHA256SUMS"), "utf8") !== checksumManifest
  ) {
    throw new Error("release bundle digest verification failed");
  }
  return {
    bundle_name: basename(directory),
    package_name: provenance.subject.name,
    package_version: provenance.subject.version,
    package_license: provenance.subject.license,
    filename,
    digests
  };
}

export function compareReleaseBundles({
  input,
  sourceCommit,
  expectedBundles = 4
} = {}) {
  if (
    typeof input !== "string" ||
    input.length < 1 ||
    input.includes("\0") ||
    !COMMIT.test(sourceCommit ?? "") ||
    !Number.isSafeInteger(expectedBundles) ||
    expectedBundles < 2
  ) {
    throw new TypeError("invalid release comparison configuration");
  }
  const directories = readdirSync(resolve(input), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => name)
    .sort();
  if (directories.length !== expectedBundles) {
    throw new Error("release comparison has an unexpected bundle count");
  }
  const bundles = directories.map((name) => inspectBundle(
    join(resolve(input), name),
    sourceCommit
  ));
  if (new Set(bundles.map(({ bundle_name: ignored, ...bundle }) =>
    canonicalJson(bundle)
  )).size !== 1) {
    throw new Error("release bundles are not byte-identical");
  }
  return deepFreeze({
    kind: "effectgate_release_qualification",
    schema_version: "1.0.0",
    source_commit: sourceCommit,
    bundle_count: bundles.length,
    bundle_names: bundles.map(({ bundle_name: name }) => name),
    package_name: bundles[0].package_name,
    package_version: bundles[0].package_version,
    package_license: bundles[0].package_license,
    package_filename: bundles[0].filename,
    digests: bundles[0].digests,
    checks: {
      provenance_source_bound: true,
      checksum_manifests_valid: true,
      byte_identical: true
    },
    verdict: "pass"
  });
}

function parseArguments(args) {
  if (
    args.length !== 4 ||
    args[0] !== "--input" ||
    args[2] !== "--source-commit"
  ) {
    throw new Error(USAGE);
  }
  return { input: args[1], sourceCommit: args[3] };
}

export function main(args = process.argv.slice(2)) {
  const result = compareReleaseBundles(parseArguments(args));
  process.stdout.write(`${canonicalJson(result)}\n`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[effectgate-release-compare] ${error.message}\n`);
    process.exitCode = 1;
  }
}
