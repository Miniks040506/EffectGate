#!/usr/bin/env node

import {
  createHash,
  sign as signBytes,
  verify as verifyBytes
} from "node:crypto";
import { readFileSync } from "node:fs";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";

export const RELEASE_EVIDENCE_GATES = Object.freeze([
  "install_uninstall",
  "known_limitations",
  "p0_kpi",
  "poc_blockers",
  "protected_effect_crash_matrix",
  "recovery_rehearsal",
  "release_reproducibility",
  "security",
  "tier1_package",
  "tier1_performance"
]);
export const RELEASE_APPROVAL_ROLES = Object.freeze([
  "product", "technical", "security", "qa", "release"
]);

const COMMIT = /^[a-f0-9]{40}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u;
const USAGE = "Usage: release-candidate.mjs --input FILE";

function exactObject(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
    });
}

function digest(domain, value) {
  return `sha256:${createHash("sha256")
    .update(`${domain}\0`)
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function canonicalTimestamp(value) {
  try {
    return typeof value === "string" && new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function normalizeEvidence(evidence, sourceCommit) {
  if (!Array.isArray(evidence) ||
      evidence.length !== RELEASE_EVIDENCE_GATES.length) {
    throw new TypeError("release evidence is incomplete");
  }
  const normalized = evidence.map((entry) => {
    if (!exactObject(entry, [
      "gate", "source_commit", "artifact_name", "artifact_digest", "verdict"
    ]) || !RELEASE_EVIDENCE_GATES.includes(entry.gate) ||
        entry.source_commit !== sourceCommit ||
        !NAME.test(entry.artifact_name ?? "") ||
        !SHA256.test(entry.artifact_digest ?? "") ||
        entry.verdict !== "pass") {
      throw new TypeError("invalid release evidence entry");
    }
    return { ...entry };
  }).sort((left, right) => left.gate < right.gate
    ? -1
    : Number(left.gate > right.gate));
  if (canonicalJson(normalized.map(({ gate }) => gate)) !==
      canonicalJson(RELEASE_EVIDENCE_GATES)) {
    throw new TypeError("release evidence gates must be unique");
  }
  return normalized;
}

function validQualification(value) {
  return value?.kind === "effectgate_release_qualification" &&
    value.schema_version === "1.0.0" && COMMIT.test(value.source_commit ?? "") &&
    value.bundle_count === 4 && Array.isArray(value.bundle_names) &&
    value.bundle_names.length === 4 && new Set(value.bundle_names).size === 4 &&
    NAME.test(value.package_name ?? "") && VERSION.test(value.package_version ?? "") &&
    value.package_license === "Apache-2.0" &&
    /^[A-Za-z0-9._-]+\.tgz$/u.test(value.package_filename ?? "") &&
    exactObject(value.digests, [
      "tarball_sha256", "sbom_sha256", "provenance_sha256"
    ]) && Object.values(value.digests).every((item) => SHA256.test(item)) &&
    value.checks?.provenance_source_bound === true &&
    value.checks?.checksum_manifests_valid === true &&
    value.checks?.byte_identical === true && value.verdict === "pass";
}

function validCandidate(candidate) {
  if (!exactObject(candidate, [
    "kind", "schema_version", "lane", "source_commit", "package",
    "evidence", "required_approvals", "candidate_digest"
  ]) || candidate.kind !== "effectgate_release_candidate" ||
      candidate.schema_version !== "1.0.0" || candidate.lane !== "rc" ||
      !COMMIT.test(candidate.source_commit ?? "") ||
      !exactObject(candidate.package, [
        "name", "version", "license", "filename", "sha256",
        "sbom_sha256", "provenance_sha256"
      ]) || !NAME.test(candidate.package.name ?? "") ||
      !VERSION.test(candidate.package.version ?? "") ||
      candidate.package.license !== "Apache-2.0" ||
      !/^[A-Za-z0-9._-]+\.tgz$/u.test(candidate.package.filename ?? "") ||
      ![candidate.package.sha256, candidate.package.sbom_sha256,
        candidate.package.provenance_sha256].every((item) => SHA256.test(item)) ||
      canonicalJson(candidate.required_approvals) !==
        canonicalJson(RELEASE_APPROVAL_ROLES)) return false;
  try {
    if (canonicalJson(candidate.evidence) !== canonicalJson(
      normalizeEvidence(candidate.evidence, candidate.source_commit)
    )) return false;
  } catch {
    return false;
  }
  const { candidate_digest: ignored, ...body } = candidate;
  return digest("effectgate.release-candidate.v1", body) ===
    candidate.candidate_digest;
}

export function compileReleaseCandidate({ releaseQualification, evidence } = {}) {
  if (!validQualification(releaseQualification)) {
    throw new TypeError("invalid release qualification");
  }
  const body = {
    kind: "effectgate_release_candidate",
    schema_version: "1.0.0",
    lane: "rc",
    source_commit: releaseQualification.source_commit,
    package: {
      name: releaseQualification.package_name,
      version: releaseQualification.package_version,
      license: releaseQualification.package_license,
      filename: releaseQualification.package_filename,
      sha256: releaseQualification.digests.tarball_sha256,
      sbom_sha256: releaseQualification.digests.sbom_sha256,
      provenance_sha256: releaseQualification.digests.provenance_sha256
    },
    evidence: normalizeEvidence(evidence, releaseQualification.source_commit),
    required_approvals: [...RELEASE_APPROVAL_ROLES]
  };
  return deepFreeze({
    ...body,
    candidate_digest: digest("effectgate.release-candidate.v1", body)
  });
}

export function createReleaseApproval({
  candidate, role, signerKeyId, privateKey, issuedAt
} = {}) {
  if (!validCandidate(candidate) || !RELEASE_APPROVAL_ROLES.includes(role) ||
      !NAME.test(signerKeyId ?? "") || !canonicalTimestamp(issuedAt)) {
    throw new TypeError("invalid release approval");
  }
  const body = {
    kind: "effectgate_release_approval",
    schema_version: "1.0.0",
    candidate_digest: candidate.candidate_digest,
    role,
    signer_key_id: signerKeyId,
    issued_at: issuedAt
  };
  try {
    return deepFreeze({
      ...body,
      signature: signBytes(null, Buffer.from(
        digest("effectgate.release-approval.v1", body), "utf8"
      ), privateKey).toString("base64url")
    });
  } catch {
    throw new TypeError("invalid release approval signer");
  }
}

export function verifyReleaseApproval(
  candidate, approval, { publicKey, signerKeyId, role } = {}
) {
  if (!validCandidate(candidate) || !exactObject(approval, [
    "kind", "schema_version", "candidate_digest", "role", "signer_key_id",
    "issued_at", "signature"
  ]) || approval.kind !== "effectgate_release_approval" ||
      approval.schema_version !== "1.0.0" ||
      approval.candidate_digest !== candidate.candidate_digest ||
      !RELEASE_APPROVAL_ROLES.includes(approval.role) ||
      approval.role !== role || approval.signer_key_id !== signerKeyId ||
      !canonicalTimestamp(approval.issued_at) ||
      !/^[A-Za-z0-9_-]+$/u.test(approval.signature ?? "")) return false;
  const { signature, ...body } = approval;
  try {
    return verifyBytes(null, Buffer.from(
      digest("effectgate.release-approval.v1", body), "utf8"
    ), publicKey, Buffer.from(signature, "base64url"));
  } catch {
    return false;
  }
}

export function verifyReleaseSignOff(candidate, approvals, trustedSigners) {
  return validCandidate(candidate) && Array.isArray(approvals) &&
    approvals.length === RELEASE_APPROVAL_ROLES.length &&
    trustedSigners instanceof Map && RELEASE_APPROVAL_ROLES.every((role) => {
      const approval = approvals.find((item) => item?.role === role);
      const signer = trustedSigners.get(role);
      return signer && verifyReleaseApproval(candidate, approval, {
        ...signer,
        role
      });
    });
}

export function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--input") throw new Error(USAGE);
  const input = JSON.parse(readFileSync(args[1], "utf8"));
  const candidate = compileReleaseCandidate({
    releaseQualification: input.release_qualification,
    evidence: input.evidence
  });
  process.stdout.write(`${canonicalJson(candidate)}\n`);
  return candidate;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`[effectgate-release-candidate] ${error.message}\n`);
    process.exitCode = 1;
  }
}
