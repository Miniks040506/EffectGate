import { createHash, randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { DatabaseSync } from "node:sqlite";

import {
  APPROVAL_CHANNELS,
  APPROVAL_PATTERNS,
  APPROVAL_SCHEMA,
  ApprovalLeaseError,
  LEASE_TTL_MS,
  MAX_CHALLENGE_TTL_MS,
  approvalFail,
  approvalTimestamp,
  approvalTokenHash,
  boundedApprovalValue
} from "./approval-lease-contract.mjs";
import { verifyEffectIntent } from "./effect-intent.mjs";
import {
  OPERATION_SCHEMA,
  transitionOperation
} from "./operation-journal-contract.mjs";
import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";

export { ApprovalLeaseError };
const { challenge: CHALLENGE, digest: DIGEST, lease: LEASE,
  token: TOKEN } = APPROVAL_PATTERNS;
const CHANNELS = APPROVAL_CHANNELS;
const SCHEMA = APPROVAL_SCHEMA;
const bounded = boundedApprovalValue;
const fail = approvalFail;
const timestamp = approvalTimestamp;
const tokenHash = approvalTokenHash;

export class ApprovalLeaseStore {
  #database;
  #deadlines = new Map();
  #monotonic;
  #now;

  constructor({ file, now = Date.now,
    monotonic = () => performance.now() } = {}) {
    if (!bounded(file, 1024) ||
        typeof now !== "function" || typeof monotonic !== "function") {
      throw new TypeError("invalid approval lease store configuration");
    }
    const databaseFile = resolve(file);
    mkdirSync(dirname(databaseFile), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(databaseFile);
    this.#database.exec(SCHEMA);
    this.#database.exec(OPERATION_SCHEMA);
    this.#now = now;
    this.#monotonic = monotonic;
  }

  createChallenge({ intent, ttlMs = 5 * 60 * 1000 } = {}) {
    verifyEffectIntent(intent);
    if (!Number.isSafeInteger(ttlMs) || ttlMs < 1 ||
        ttlMs > MAX_CHALLENGE_TTL_MS) {
      throw new TypeError("invalid approval challenge TTL");
    }
    const clock = this.#begin();
    try {
      const expiry = Math.min(clock.wall + ttlMs, Date.parse(intent.expires_at));
      if (expiry <= clock.wall) fail("EG_APPROVAL_EXPIRED");
      const challengeId = `chal_${randomBytes(18).toString("base64url")}`;
      const summary = {
        capability_id: intent.capability_id,
        effect_class: intent.effect_class,
        resource_scope: intent.resource_scope
      };
      this.#database.prepare(`INSERT INTO approval_challenges
        (challenge_id, intent_digest, principal_id, client_id, session_id,
         policy_revision, capability_revision, summary_json, created_at,
         expires_at, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')
      `).run(
        challengeId, intent.intent_digest, intent.principal_id, intent.client_id,
        intent.session_id, intent.policy_revision, intent.capability_revision,
        canonicalJson(summary), timestamp(clock.wall), timestamp(expiry)
      );
      this.#database.exec("COMMIT");
      return deepFreeze({
        challenge_id: challengeId,
        intent_digest: intent.intent_digest,
        summary,
        expires_at: timestamp(expiry),
        status: "pending"
      });
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  approveChallenge({ challengeId, approverId, channel } = {}) {
    if (!CHALLENGE.test(challengeId ?? "") ||
        !bounded(approverId) || !CHANNELS.includes(channel)) {
      throw new TypeError("invalid approval decision");
    }
    const token = `egl_${randomBytes(32).toString("base64url")}`;
    const leaseHash = tokenHash(token);
    const leaseRef = `lease_${leaseHash.slice(-24)}`;
    const clock = this.#begin();
    let result;
    try {
      const challenge = this.#database.prepare(
        "SELECT * FROM approval_challenges WHERE challenge_id=?"
      ).get(challengeId);
      if (!challenge || challenge.status !== "pending") {
        result = "EG_APPROVAL_NOT_ADMISSIBLE";
      } else if (Date.parse(challenge.expires_at) <= clock.wall) {
        this.#database.prepare(`UPDATE approval_challenges SET
          status='expired', decided_at=? WHERE challenge_id=?
          AND status='pending'`).run(timestamp(clock.wall), challengeId);
        result = "EG_APPROVAL_EXPIRED";
      } else {
        const expiry = Math.min(
          Date.parse(challenge.expires_at),
          clock.wall + LEASE_TTL_MS
        );
        this.#database.prepare(`UPDATE approval_challenges SET
          status='approved', decided_at=?, approver_id=?, channel=?
          WHERE challenge_id=? AND status='pending'`)
          .run(timestamp(clock.wall), approverId, channel, challengeId);
        this.#database.prepare(`INSERT INTO approval_leases
          (lease_ref, lease_hash, challenge_id, intent_digest, session_id,
           policy_revision, capability_revision, issued_at, expires_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          leaseRef, leaseHash, challengeId, challenge.intent_digest,
          challenge.session_id, challenge.policy_revision,
          challenge.capability_revision, timestamp(clock.wall), timestamp(expiry)
        );
        result = deepFreeze({
          lease_token: token,
          lease_ref: leaseRef,
          intent_digest: challenge.intent_digest,
          expires_at: timestamp(expiry)
        });
        this.#deadlines.set(leaseHash, {
          issued: clock.monotonic,
          deadline: clock.monotonic + (expiry - clock.wall)
        });
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
    if (typeof result === "string") fail(result);
    return result;
  }

  admitOperation({ leaseToken, intent, operationId } = {}) {
    try {
      verifyEffectIntent(intent);
    } catch {
      fail();
    }
    if (!TOKEN.test(leaseToken ?? "") || !bounded(operationId)) fail();
    const leaseHash = tokenHash(leaseToken);
    const clock = this.#begin();
    let row;
    let reason;
    let proof;
    let expired = false;
    try {
      row = this.#database.prepare(
        "SELECT * FROM approval_leases WHERE lease_hash=?"
      ).get(leaseHash);
      const operation = this.#database.prepare(
        "SELECT * FROM operations WHERE operation_id=?"
      ).get(operationId);
      const monotonic = this.#deadlines.get(leaseHash);
      expired = Boolean(row && (
        Date.parse(row.expires_at) <= clock.wall ||
        (monotonic && (clock.monotonic < monotonic.issued ||
          clock.monotonic >= monotonic.deadline))
      ));
      if (expired && !row.expired_at) {
        this.#database.prepare(`UPDATE approval_leases SET expired_at=?
          WHERE lease_hash=? AND expired_at IS NULL`)
          .run(timestamp(clock.wall), leaseHash);
      }
      if (!row || row.consumed_at || row.revoked_at || row.expired_at ||
          expired || row.intent_digest !== intent.intent_digest ||
          row.session_id !== intent.session_id || !operation ||
          operation.state !== "awaiting_approval" ||
          operation.approval_required !== 1 ||
          operation.intent_digest !== intent.intent_digest ||
          operation.session_id !== intent.session_id ||
          operation.challenge_id !== row.challenge_id) {
        reason = expired ? "EG_APPROVAL_EXPIRED" : "EG_APPROVAL_NOT_ADMISSIBLE";
      } else if (this.#database.prepare(
        "SELECT 1 FROM approval_leases WHERE operation_id=?"
      ).get(operationId)) {
        reason = "EG_APPROVAL_NOT_ADMISSIBLE";
      } else {
        const changed = this.#database.prepare(`UPDATE approval_leases SET
          consumed_at=?, operation_id=? WHERE lease_hash=?
          AND consumed_at IS NULL AND revoked_at IS NULL AND expired_at IS NULL`)
          .run(timestamp(clock.wall), operationId, leaseHash).changes;
        if (changed !== 1) {
          reason = "EG_APPROVAL_NOT_ADMISSIBLE";
        } else {
          const body = {
            lease_ref: row.lease_ref,
            intent_digest: row.intent_digest,
            operation_id: operationId,
            consumed_at: timestamp(clock.wall)
          };
          proof = {
            ...body,
            approval_proof_digest: `sha256:${createHash("sha256")
              .update("effectgate.approval-proof.v1\0")
              .update(canonicalJson(body))
              .digest("hex")}`
          };
          transitionOperation(this.#database, {
            operationId,
            fromState: "awaiting_approval",
            toState: "admitted",
            certainty: "not_started",
            observedAt: timestamp(clock.wall),
            monotonicMs: clock.monotonic,
            evidenceRef: proof.approval_proof_digest,
            approvalProofDigest: proof.approval_proof_digest
          });
        }
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
    if (!reason || expired || row?.consumed_at ||
        row?.revoked_at || row?.expired_at) {
      this.#deadlines.delete(leaseHash);
    }
    if (reason) fail(reason);
    return deepFreeze(proof);
  }

  revoke(selector = {}) {
    const fields = {
      challengeId: ["challenge_id", selector.challengeId],
      leaseRef: ["lease_ref", selector.leaseRef],
      sessionId: ["session_id", selector.sessionId],
      policyRevision: ["policy_revision", selector.policyRevision],
      capabilityRevision: [
        "capability_revision", selector.capabilityRevision
      ]
    };
    const selected = Object.entries(fields)
      .filter(([, [, value]]) => value !== undefined);
    if (selected.length !== 1 || Object.keys(selector).length !== 1) {
      throw new TypeError("revocation requires one exact selector");
    }
    const [name, [column, value]] = selected[0];
    if ((name === "challengeId" && !CHALLENGE.test(value)) ||
        (name === "leaseRef" && !LEASE.test(value)) ||
        (name === "policyRevision" && !DIGEST.test(value)) ||
        (!["challengeId", "leaseRef", "policyRevision"].includes(name) &&
          !bounded(value, 256))) {
      throw new TypeError("invalid revocation selector");
    }
    const clock = this.#begin();
    let changes = 0;
    try {
      const at = timestamp(clock.wall);
      if (name !== "leaseRef") {
        changes += this.#database.prepare(`UPDATE approval_challenges SET
          status='revoked', decided_at=? WHERE ${column}=? AND status='pending'`)
          .run(at, value).changes;
      }
      const leaseColumn = name === "challengeId" ? "challenge_id" : column;
      if (name !== "leaseRef" || LEASE.test(value)) {
        changes += this.#database.prepare(`UPDATE approval_leases SET
          revoked_at=? WHERE ${leaseColumn}=? AND consumed_at IS NULL
          AND revoked_at IS NULL AND expired_at IS NULL`)
          .run(at, value).changes;
      }
      this.#database.exec("COMMIT");
    } catch (error) {
      this.#rollback();
      throw error;
    }
    return deepFreeze({ revoked: changes, revoked_at: timestamp(clock.wall) });
  }

  close() {
    this.#database.close();
  }

  #begin() {
    const wall = this.#now();
    const monotonic = this.#monotonic();
    if (!Number.isSafeInteger(wall) || !Number.isFinite(monotonic) ||
        monotonic < 0 || Number.isNaN(new Date(wall).getTime())) {
      fail("EG_APPROVAL_CLOCK_INVALID");
    }
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const approvalMaximum = this.#database.prepare(
        "SELECT max_wall_ms FROM approval_clock WHERE singleton=1"
      ).get().max_wall_ms;
      const operationMaximum = this.#database.prepare(
        "SELECT max_wall_ms FROM operation_clock WHERE singleton=1"
      ).get().max_wall_ms;
      const maximum = Math.max(approvalMaximum, operationMaximum);
      if (wall < maximum) {
        const at = timestamp(maximum);
        this.#database.prepare(`UPDATE approval_challenges SET
          status='revoked', decided_at=? WHERE status='pending'`).run(at);
        this.#database.prepare(`UPDATE approval_leases SET revoked_at=?
          WHERE consumed_at IS NULL AND revoked_at IS NULL
          AND expired_at IS NULL`).run(at);
        this.#database.exec("COMMIT");
        fail("EG_APPROVAL_CLOCK_ROLLBACK");
      }
      this.#database.prepare(
        "UPDATE approval_clock SET max_wall_ms=? WHERE singleton=1"
      ).run(wall);
      this.#database.prepare(
        "UPDATE operation_clock SET max_wall_ms=? WHERE singleton=1"
      ).run(wall);
      return { wall, monotonic };
    } catch (error) {
      this.#rollback();
      throw error;
    }
  }

  #rollback() {
    try {
      this.#database.exec("ROLLBACK");
    } catch {}
  }
}
