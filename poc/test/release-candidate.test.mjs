import assert from "node:assert/strict";
import { createHash, generateKeyPairSync } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  RELEASE_APPROVAL_ROLES,
  RELEASE_EVIDENCE_GATES,
  compileReleaseCandidate,
  createReleaseApproval,
  verifyReleaseSignOff
} from "../src/release/release-candidate.mjs";
import {
  compileReleaseCandidateFromFiles
} from "../src/release/release-evidence.mjs";
import {
  approveReleaseCandidateFromFiles,
  verifyReleaseSignOffFromFiles
} from "../src/release/release-approval.mjs";
import { canonicalJson } from "../src/skill/passport-compiler.mjs";

const sha256 = (value) => `sha256:${createHash("sha256")
  .update(value).digest("hex")}`;

test("release candidate binds complete evidence and all role approvals", () => {
  const sourceCommit = "a".repeat(40);
  const releaseQualification = {
    kind: "effectgate_release_qualification",
    schema_version: "1.0.0",
    source_commit: sourceCommit,
    bundle_count: 4,
    bundle_names: ["linux-x64", "linux-arm64", "windows-x64", "macos-arm64"],
    package_name: "effectgate-preview",
    package_version: "1.0.0",
    package_license: "Apache-2.0",
    package_filename: "effectgate-preview-1.0.0.tgz",
    digests: {
      tarball_sha256: sha256("package"),
      sbom_sha256: sha256("sbom"),
      provenance_sha256: sha256("provenance")
    },
    checks: {
      provenance_source_bound: true,
      checksum_manifests_valid: true,
      byte_identical: true
    },
    verdict: "pass"
  };
  const evidence = RELEASE_EVIDENCE_GATES.map((gate) => ({
    gate,
    source_commit: sourceCommit,
    artifact_name: `${gate}.json`,
    artifact_digest: sha256(gate),
    verdict: "pass"
  })).reverse();
  const candidate = compileReleaseCandidate({
    releaseQualification,
    evidence
  });
  assert.deepEqual(candidate.evidence.map(({ gate }) => gate),
    RELEASE_EVIDENCE_GATES);
  assert.deepEqual(candidate, compileReleaseCandidate({
    releaseQualification,
    evidence: [...evidence].reverse()
  }));
  assert.match(candidate.candidate_digest, /^sha256:[a-f0-9]{64}$/u);

  const trustedSigners = new Map();
  const approvals = RELEASE_APPROVAL_ROLES.map((role) => {
    const keys = generateKeyPairSync("ed25519");
    const signerKeyId = `${role}-key-1`;
    trustedSigners.set(role, { publicKey: keys.publicKey, signerKeyId });
    return createReleaseApproval({
      candidate,
      role,
      signerKeyId,
      privateKey: keys.privateKey,
      issuedAt: "2026-08-02T00:00:00.000Z"
    });
  });
  assert.equal(verifyReleaseSignOff(candidate, approvals, trustedSigners), true);
  assert.equal(verifyReleaseSignOff(
    candidate,
    approvals.map((approval, index) => index === 0
      ? { ...approval, candidate_digest: sha256("wrong") }
      : approval),
    trustedSigners
  ), false);
  assert.throws(() => compileReleaseCandidate({
    releaseQualification,
    evidence: evidence.slice(1)
  }), /incomplete/u);

  const directory = mkdtempSync(join(tmpdir(), "effectgate-rc-evidence-"));
  const writeCanonical = (name, value) => {
    writeFileSync(join(directory, name), `${canonicalJson(value)}\n`);
    return name;
  };
  try {
    const qualificationPath = writeCanonical(
      "release-qualification.json",
      releaseQualification
    );
    const evidencePaths = RELEASE_EVIDENCE_GATES.map((gate) => ({
      gate,
      path: gate === "release_reproducibility"
        ? qualificationPath
        : writeCanonical(`${gate}.json`, {
          kind: "effectgate_release_gate_evidence",
          schema_version: "1.0.0",
          gate,
          source_commit: sourceCommit,
          verdict: "pass",
          artifact: {
            name: `${gate}.artifact`,
            digest: sha256(gate)
          }
        })
    }));
    const input = join(directory, "release-input.json");
    writeFileSync(input, JSON.stringify({
      release_qualification: qualificationPath,
      evidence: evidencePaths.reverse()
    }, null, 2));
    const admitted = compileReleaseCandidateFromFiles({ input });
    assert.deepEqual(admitted.package, candidate.package);
    assert.deepEqual(admitted.evidence.map(({ gate }) => gate),
      RELEASE_EVIDENCE_GATES);
    assert.deepEqual(admitted,
      compileReleaseCandidateFromFiles({ input }));

    const candidatePath = writeCanonical("release-candidate.json", admitted);
    const fileApprovals = [];
    const fileSigners = RELEASE_APPROVAL_ROLES.map((role) => {
      const keys = generateKeyPairSync("ed25519");
      const signerKeyId = `${role}-file-key-1`;
      const privateKey = `${role}.private.pem`;
      const publicKey = `${role}.public.pem`;
      const approval = `${role}.approval.json`;
      writeFileSync(join(directory, privateKey), keys.privateKey.export({
        type: "pkcs8",
        format: "pem"
      }));
      chmodSync(join(directory, privateKey), 0o600);
      writeFileSync(join(directory, publicKey), keys.publicKey.export({
        type: "spki",
        format: "pem"
      }));
      const value = approveReleaseCandidateFromFiles({
        candidateFile: join(directory, candidatePath),
        role,
        signerKeyId,
        privateKeyFile: join(directory, privateKey),
        issuedAt: "2026-08-02T00:00:00.000Z"
      });
      fileApprovals.push(value);
      writeCanonical(approval, value);
      return {
        role,
        signer_key_id: signerKeyId,
        public_key: publicKey,
        approval
      };
    });
    const signOffInput = join(directory, "release-signoff-input.json");
    writeFileSync(signOffInput, JSON.stringify({
      kind: "effectgate_release_signoff_input",
      schema_version: "1.0.0",
      candidate_digest: admitted.candidate_digest,
      signers: fileSigners.reverse()
    }, null, 2));
    const signOff = verifyReleaseSignOffFromFiles({
      candidateFile: join(directory, candidatePath),
      signOffFile: signOffInput
    });
    assert.equal(signOff.verdict, "pass");
    assert.deepEqual(signOff.approvals.map(({ role }) => role),
      RELEASE_APPROVAL_ROLES);
    assert.equal(signOff.approvals.every(({ public_key_sha256 }) =>
      /^sha256:[a-f0-9]{64}$/u.test(public_key_sha256)), true);
    writeCanonical("product.approval.json", {
      ...fileApprovals[0],
      signature: (fileApprovals[0].signature.startsWith("A") ? "B" : "A") +
        fileApprovals[0].signature.slice(1)
    });
    assert.throws(() => verifyReleaseSignOffFromFiles({
      candidateFile: join(directory, candidatePath),
      signOffFile: signOffInput
    }), /verification failed/u);

    writeCanonical("security.json", {
      kind: "effectgate_release_gate_evidence",
      schema_version: "1.0.0",
      gate: "security",
      source_commit: sourceCommit,
      verdict: "fail"
    });
    assert.throws(
      () => compileReleaseCandidateFromFiles({ input }),
      /source-bound pass/u
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
