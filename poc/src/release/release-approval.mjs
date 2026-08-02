#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey
} from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  RELEASE_APPROVAL_ROLES,
  createReleaseApproval,
  verifyReleaseSignOff
} from "./release-candidate.mjs";
import { readReleaseJson } from "./release-evidence.mjs";
import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";

const MAX_KEY_BYTES = 64 * 1024;
const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const USAGE = "Usage: release-approval.mjs approve --candidate FILE " +
  "--role ROLE --signer-key-id ID --private-key FILE --issued-at ISO | " +
  "verify --candidate FILE --sign-off FILE";

function exactObject(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function readKey(file, privateKey = false) {
  if (typeof file !== "string" || file.length < 1 || file.includes("\0")) {
    throw new TypeError("invalid release key path");
  }
  const absolute = resolve(file);
  const stat = lstatSync(absolute);
  if (!stat.isFile() || stat.size < 32 || stat.size > MAX_KEY_BYTES ||
      (privateKey && process.platform !== "win32" && (stat.mode & 0o077))) {
    throw new Error("release key must be a protected bounded regular file");
  }
  try {
    const path = realpathSync(absolute);
    const bytes = readFileSync(path);
    const key = privateKey
      ? createPrivateKey(bytes)
      : createPublicKey(bytes);
    if (key.asymmetricKeyType !== "ed25519") {
      throw new Error("wrong key type");
    }
    return { path, key, bytes };
  } catch {
    throw new Error("release key must be valid Ed25519 PEM");
  }
}

const fileDigest = (bytes) => `sha256:${createHash("sha256")
  .update(bytes).digest("hex")}`;

export function approveReleaseCandidateFromFiles({
  candidateFile,
  role,
  signerKeyId,
  privateKeyFile,
  issuedAt
} = {}) {
  const candidate = readReleaseJson(candidateFile, true).value;
  const privateKey = readKey(privateKeyFile, true).key;
  return createReleaseApproval({
    candidate,
    role,
    signerKeyId,
    privateKey,
    issuedAt
  });
}

export function verifyReleaseSignOffFromFiles({
  candidateFile,
  signOffFile
} = {}) {
  const candidateDocument = readReleaseJson(candidateFile, true);
  const signOffDocument = readReleaseJson(signOffFile);
  const input = signOffDocument.value;
  if (!exactObject(input, [
    "kind", "schema_version", "candidate_digest", "signers"
  ]) || input.kind !== "effectgate_release_signoff_input" ||
      input.schema_version !== "1.0.0" ||
      !SHA256.test(input.candidate_digest ?? "") ||
      input.candidate_digest !== candidateDocument.value.candidate_digest ||
      !Array.isArray(input.signers) ||
      input.signers.length !== RELEASE_APPROVAL_ROLES.length ||
      input.signers.some((signer) => !exactObject(signer, [
        "role", "signer_key_id", "public_key", "approval"
      ]) || !RELEASE_APPROVAL_ROLES.includes(signer.role) ||
        [signer.signer_key_id, signer.public_key, signer.approval]
          .some((value) => typeof value !== "string" || value.length < 1 ||
            value.includes("\0"))) ||
      canonicalJson(input.signers.map(({ role }) => role).sort()) !==
        canonicalJson([...RELEASE_APPROVAL_ROLES].sort())) {
    throw new TypeError("invalid release sign-off input");
  }
  const root = dirname(signOffDocument.path);
  const trustedSigners = new Map();
  const loaded = input.signers.map((signer) => {
    const publicKey = readKey(resolve(root, signer.public_key));
    const approval = readReleaseJson(resolve(root, signer.approval), true);
    trustedSigners.set(signer.role, {
      publicKey: publicKey.key,
      signerKeyId: signer.signer_key_id
    });
    return {
      role: signer.role,
      signer_key_id: signer.signer_key_id,
      public_key_path: publicKey.path,
      approval_path: approval.path,
      approval: approval.value,
      public_key_sha256: fileDigest(publicKey.bytes),
      approval_sha256: fileDigest(approval.bytes)
    };
  }).sort((left, right) => RELEASE_APPROVAL_ROLES.indexOf(left.role) -
    RELEASE_APPROVAL_ROLES.indexOf(right.role));
  if (new Set(loaded.map(({ approval_path: path }) => path)).size !==
      loaded.length || !verifyReleaseSignOff(
        candidateDocument.value,
        loaded.map(({ approval }) => approval),
        trustedSigners
      )) {
    throw new Error("release sign-off verification failed");
  }
  return deepFreeze({
    kind: "effectgate_release_signoff",
    schema_version: "1.0.0",
    candidate_digest: candidateDocument.value.candidate_digest,
    candidate_sha256: fileDigest(candidateDocument.bytes),
    approvals: loaded.map(({
      role, signer_key_id, public_key_sha256, approval_sha256
    }) => ({
      role, signer_key_id, public_key_sha256, approval_sha256
    })),
    verdict: "pass"
  });
}

function parseArguments(args) {
  if (args.length === 11 && args[0] === "approve" &&
      args[1] === "--candidate" && args[3] === "--role" &&
      args[5] === "--signer-key-id" && args[7] === "--private-key" &&
      args[9] === "--issued-at") {
    return {
      command: "approve",
      candidateFile: args[2],
      role: args[4],
      signerKeyId: args[6],
      privateKeyFile: args[8],
      issuedAt: args[10]
    };
  }
  if (args.length === 5 && args[0] === "verify" &&
      args[1] === "--candidate" && args[3] === "--sign-off") {
    return {
      command: "verify",
      candidateFile: args[2],
      signOffFile: args[4]
    };
  }
  throw new Error(USAGE);
}

export function main(args = process.argv.slice(2)) {
  const options = parseArguments(args);
  const result = options.command === "approve"
    ? approveReleaseCandidateFromFiles(options)
    : verifyReleaseSignOffFromFiles(options);
  process.stdout.write(`${canonicalJson(result)}\n`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`[effectgate-release-approval] ${error.message}\n`);
    process.exitCode = 1;
  }
}
