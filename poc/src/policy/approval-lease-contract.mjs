import { createHash } from "node:crypto";

export const APPROVAL_PATTERNS = Object.freeze({
  digest: /^sha256:[a-f0-9]{64}$/u,
  challenge: /^chal_[A-Za-z0-9_-]{24}$/u,
  lease: /^lease_[a-f0-9]{24}$/u,
  token: /^egl_[A-Za-z0-9_-]{43}$/u
});
export const APPROVAL_CHANNELS = Object.freeze([
  "cli", "local_tui", "mcp_elicitation"
]);
export const MAX_CHALLENGE_TTL_MS = 10 * 60 * 1000;
export const LEASE_TTL_MS = 2 * 60 * 1000;

export const APPROVAL_SCHEMA = `
PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS approval_clock (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1), max_wall_ms INTEGER NOT NULL
) STRICT;
INSERT OR IGNORE INTO approval_clock VALUES (1, 0);
CREATE TABLE IF NOT EXISTS approval_challenges (
  challenge_id TEXT PRIMARY KEY, intent_digest TEXT NOT NULL,
  principal_id TEXT NOT NULL, client_id TEXT NOT NULL, session_id TEXT NOT NULL,
  policy_revision TEXT NOT NULL, capability_revision TEXT NOT NULL,
  summary_json TEXT NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('pending','approved','revoked','expired')),
  decided_at TEXT, approver_id TEXT, channel TEXT) STRICT;
CREATE TABLE IF NOT EXISTS approval_leases (
  lease_ref TEXT PRIMARY KEY, lease_hash TEXT NOT NULL UNIQUE,
  challenge_id TEXT NOT NULL UNIQUE, intent_digest TEXT NOT NULL,
  session_id TEXT NOT NULL, policy_revision TEXT NOT NULL,
  capability_revision TEXT NOT NULL, issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL, consumed_at TEXT, revoked_at TEXT, expired_at TEXT,
  operation_id TEXT UNIQUE, FOREIGN KEY(challenge_id)
  REFERENCES approval_challenges(challenge_id)) STRICT;
CREATE INDEX IF NOT EXISTS approval_challenges_session ON
  approval_challenges(session_id, status);
CREATE INDEX IF NOT EXISTS approval_leases_session ON
  approval_leases(session_id, consumed_at, revoked_at, expired_at);
PRAGMA user_version=2;
`;

export class ApprovalLeaseError extends Error {
  constructor(code) {
    super("approval lease is not admissible");
    this.name = "ApprovalLeaseError";
    this.code = code;
  }
}

export function approvalFail(code = "EG_APPROVAL_NOT_ADMISSIBLE") {
  throw new ApprovalLeaseError(code);
}

export function boundedApprovalValue(value, maximum = 128) {
  return typeof value === "string" && value.length >= 1 &&
    value.length <= maximum && Buffer.byteLength(value, "utf8") <= maximum * 4 &&
    !value.includes("\0") && value === value.normalize("NFC");
}

export function approvalTokenHash(token) {
  return `sha256:${createHash("sha256")
    .update("effectgate.approval-lease.v1\0")
    .update(token)
    .digest("hex")}`;
}

export const approvalTimestamp = (milliseconds) =>
  new Date(milliseconds).toISOString();
