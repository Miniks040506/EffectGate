#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";

const PACKAGE_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))));
const COMMIT = /^[a-f0-9]{40}$/u;
const USAGE =
  "Usage: release-bundle.mjs --output DIRECTORY --source-commit SHA";

function runNpm(args, cwd, npmExecPath) {
  if (typeof npmExecPath !== "string" || npmExecPath.length < 1) {
    throw new Error("release bundle must run through npm");
  }
  const result = spawnSync(process.execPath, [npmExecPath, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
      npm_config_offline: "true",
      npm_config_update_notifier: "false"
    }
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error(result.stderr.trim() || "npm command failed");
  }
  return result.stdout.trim();
}

function sha256(file) {
  return createHash("sha256").update(readFileSync(file)).digest("hex");
}

export function createReleaseBundle({
  output,
  sourceCommit,
  packageRoot = PACKAGE_ROOT,
  npmExecPath = process.env.npm_execpath
} = {}) {
  if (
    typeof output !== "string" ||
    output.length < 1 ||
    output.includes("\0") ||
    !COMMIT.test(sourceCommit ?? "") ||
    typeof packageRoot !== "string" ||
    packageRoot.length < 1
  ) {
    throw new TypeError("invalid release bundle configuration");
  }
  const destination = resolve(output);
  if (existsSync(destination)) {
    throw new Error("release bundle destination already exists");
  }
  mkdirSync(dirname(destination), { recursive: true });
  mkdirSync(destination);
  try {
    const manifest = JSON.parse(readFileSync(
      join(packageRoot, "package.json"),
      "utf8"
    ));
    const packed = JSON.parse(runNpm([
      "pack",
      "--ignore-scripts",
      "--json",
      "--pack-destination",
      destination
    ], packageRoot, npmExecPath));
    if (
      packed.length !== 1 ||
      packed[0].name !== manifest.name ||
      packed[0].version !== manifest.version ||
      manifest.license !== "Apache-2.0" ||
      typeof packed[0].filename !== "string" ||
      !/^sha512-[A-Za-z0-9+/=]+$/u.test(packed[0].integrity ?? "")
    ) {
      throw new Error("invalid npm pack result");
    }
    const tarball = join(destination, packed[0].filename);
    const tarballDigest = sha256(tarball);
    const sbom = JSON.parse(runNpm([
      "sbom",
      "--sbom-format=cyclonedx"
    ], packageRoot, npmExecPath));
    if (
      sbom.bomFormat !== "CycloneDX" ||
      sbom.specVersion !== "1.5" ||
      typeof sbom.metadata?.component !== "object" ||
      sbom.metadata.component.version !== manifest.version ||
      !Array.isArray(sbom.metadata.component.properties) ||
      !Array.isArray(sbom.components) ||
      sbom.components.length !== 0 ||
      !Array.isArray(sbom.dependencies) ||
      sbom.dependencies.length !== 1 ||
      !Array.isArray(sbom.dependencies[0].dependsOn) ||
      sbom.dependencies[0].dependsOn.length !== 0
    ) {
      throw new Error("invalid dependency-free npm SBOM");
    }
    delete sbom.serialNumber;
    delete sbom.metadata.timestamp;
    sbom.metadata.component.name = manifest.name;
    sbom.metadata.component.hashes = [
      { alg: "SHA-256", content: tarballDigest }
    ];
    sbom.metadata.component.properties.push(
      { name: "dev.effectgate/source-commit", value: sourceCommit },
      { name: "dev.effectgate/package-file", value: packed[0].filename }
    );
    const sbomFile = join(destination, "sbom.cdx.json");
    writeFileSync(sbomFile, `${canonicalJson(sbom)}\n`, { flag: "wx" });
    const sbomDigest = sha256(sbomFile);
    const provenance = {
      kind: "effectgate_release_provenance",
      schema_version: "1.0.0",
      source: {
        repository: manifest.repository.url,
        commit_sha: sourceCommit
      },
      subject: {
        name: packed[0].name,
        version: packed[0].version,
        license: manifest.license,
        filename: packed[0].filename,
        size_bytes: statSync(tarball).size,
        sha256: `sha256:${tarballDigest}`,
        npm_integrity: packed[0].integrity
      },
      sbom: {
        filename: "sbom.cdx.json",
        format: sbom.bomFormat,
        spec_version: sbom.specVersion,
        sha256: `sha256:${sbomDigest}`
      },
      builder: {
        node_version: process.version,
        npm_version: runNpm(["--version"], packageRoot, npmExecPath)
      },
      build: {
        command: "npm pack --ignore-scripts --json",
        network: "offline",
        lifecycle_scripts: false
      }
    };
    const provenanceFile = join(destination, "provenance.json");
    writeFileSync(
      provenanceFile,
      `${canonicalJson(provenance)}\n`,
      { flag: "wx" }
    );
    const provenanceDigest = sha256(provenanceFile);
    writeFileSync(
      join(destination, "SHA256SUMS"),
      `${tarballDigest}  ${packed[0].filename}\n` +
        `${sbomDigest}  sbom.cdx.json\n` +
        `${provenanceDigest}  provenance.json\n`,
      { flag: "wx" }
    );
    return deepFreeze({
      output: destination,
      provenance,
      sbom_digest: `sha256:${sbomDigest}`,
      provenance_digest: `sha256:${provenanceDigest}`
    });
  } catch (error) {
    rmSync(destination, { recursive: true, force: true });
    throw error;
  }
}

function parseArguments(args) {
  if (
    args.length !== 4 ||
    args[0] !== "--output" ||
    args[2] !== "--source-commit"
  ) {
    throw new Error(USAGE);
  }
  return { output: args[1], sourceCommit: args[3] };
}

export function main(args = process.argv.slice(2)) {
  const result = createReleaseBundle(parseArguments(args));
  process.stdout.write(`${canonicalJson(result)}\n`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`[effectgate-release] ${error.message}\n`);
    process.exitCode = 1;
  }
}
