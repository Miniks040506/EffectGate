import {
  createHash,
  sign as signBytes,
  verify as verifyBytes
} from "node:crypto";

import {
  OPERATION_PATTERNS,
  boundedOperationValue,
  loadOperation,
  operationFail
} from "./operation-journal-contract.mjs";
import { loadOperationReconciliation } from "./operation-reconciliation.mjs";
import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";

const TERMINAL_STATES = new Set([
  "verified_committed", "verified_not_committed", "manual_resolution"
]);
const EFFECT_CLASSES = new Set([
  "observe", "disclose", "mutate_reversible", "mutate_irreversible",
  "destructive", "external_commit", "credential_use", "code_execution"
]);
const RECEIPT_FIELDS = Object.freeze([
  "schema_version", "receipt_id", "operation_id", "principal_id",
  "client_id", "session_id", "transaction_id", "skill_id", "skill_digest",
  "phase", "phase_revision", "capsule_digest", "capability_id",
  "capability_revision", "effect_class", "intent_digest",
  "canonical_arguments_hash", "resource_scope_digest", "disclosure_digest",
  "policy_revision", "approval_proof_digest", "dispatch_digest",
  "idempotency_key_digest", "safe_summary",
  "verification_evidence_digest", "final_state", "certainty",
  "event_chain_head", "operation_created_at", "finalized_at", "issued_at",
  "previous_receipt_hash", "signer_key_id", "signature", "receipt_hash"
]);

export const EFFECT_RECEIPT_SCHEMA = `
CREATE TABLE IF NOT EXISTS effect_receipt_chain_head (
  singleton INTEGER PRIMARY KEY CHECK(singleton=1),
  receipt_count INTEGER NOT NULL CHECK(receipt_count >= 0),
  receipt_hash TEXT
) STRICT;
INSERT OR IGNORE INTO effect_receipt_chain_head VALUES (1, 0, NULL);
CREATE TABLE IF NOT EXISTS effect_receipts (
  sequence INTEGER NOT NULL UNIQUE CHECK(sequence > 0),
  receipt_id TEXT PRIMARY KEY, operation_id TEXT NOT NULL UNIQUE,
  issued_at TEXT NOT NULL, previous_receipt_hash TEXT,
  receipt_hash TEXT NOT NULL UNIQUE, receipt_json TEXT NOT NULL,
  FOREIGN KEY(operation_id) REFERENCES operations(operation_id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS effect_receipts_no_update
BEFORE UPDATE ON effect_receipts BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER IF NOT EXISTS effect_receipts_no_delete
BEFORE DELETE ON effect_receipts BEGIN SELECT RAISE(ABORT, 'immutable'); END;
PRAGMA user_version=6;
`;

function exactObject(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
    });
}

function canonicalTimestamp(value) {
  try {
    return typeof value === "string" &&
      new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function digest(domain, value) {
  return `sha256:${createHash("sha256")
    .update(`${domain}\0`)
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function receiptHash(receipt) {
  const { receipt_hash: ignored, ...body } = receipt;
  return digest("effectgate.effect-receipt.v1", body);
}

function signingDigest(body) {
  return digest("effectgate.effect-receipt-signature.v1", body);
}

function validReceipt(receipt) {
  const digestValue = (value) =>
    OPERATION_PATTERNS.digest.test(value ?? "");
  const nullableDigest = (value) => value === null || digestValue(value);
  const names = [
    "principal_id", "client_id", "session_id", "transaction_id",
    "skill_id", "phase"
  ];
  const digests = [
    "skill_digest", "capsule_digest", "intent_digest",
    "canonical_arguments_hash", "resource_scope_digest",
    "disclosure_digest", "policy_revision", "dispatch_digest",
    "verification_evidence_digest", "event_chain_head"
  ];
  const timestamps = [
    "operation_created_at", "finalized_at", "issued_at"
  ];
  if (!exactObject(receipt, RECEIPT_FIELDS) ||
      receipt.schema_version !== "1.0.0" ||
      !boundedOperationValue(
        receipt.receipt_id, 128, OPERATION_PATTERNS.identifier
      ) ||
      !boundedOperationValue(
        receipt.operation_id, 128, OPERATION_PATTERNS.identifier
      ) ||
      names.some((key) => !boundedOperationValue(receipt[key], 128)) ||
      digests.some((key) => !digestValue(receipt[key])) ||
      !Number.isSafeInteger(receipt.phase_revision) ||
      receipt.phase_revision < 1 ||
      !boundedOperationValue(receipt.capability_id, 512) ||
      !boundedOperationValue(receipt.capability_revision, 256) ||
      !EFFECT_CLASSES.has(receipt.effect_class) ||
      !nullableDigest(receipt.approval_proof_digest) ||
      !nullableDigest(receipt.idempotency_key_digest) ||
      !boundedOperationValue(receipt.safe_summary, 256) ||
      !TERMINAL_STATES.has(receipt.final_state) ||
      !timestamps.every((key) => canonicalTimestamp(receipt[key])) ||
      Date.parse(receipt.operation_created_at) >
        Date.parse(receipt.finalized_at) ||
      Date.parse(receipt.finalized_at) > Date.parse(receipt.issued_at) ||
      !nullableDigest(receipt.previous_receipt_hash) ||
      !digestValue(receipt.receipt_hash)) {
    return false;
  }
  const certaintyValid = receipt.final_state === "verified_committed"
    ? receipt.certainty === "verified_committed"
    : receipt.final_state === "verified_not_committed"
      ? receipt.certainty === "verified_not_committed"
      : ["started_no_commit_evidence", "commit_possible",
        "backend_claimed_committed"].includes(receipt.certainty);
  const signed = receipt.signer_key_id !== null ||
    receipt.signature !== null;
  return certaintyValid && (signed
    ? boundedOperationValue(receipt.signer_key_id, 256) &&
      boundedOperationValue(receipt.signature, 4096) &&
      /^[A-Za-z0-9_-]+$/u.test(receipt.signature)
    : receipt.signer_key_id === null && receipt.signature === null) &&
    receiptHash(receipt) === receipt.receipt_hash;
}

export function verifyEffectReceipt(
  receipt, { publicKey, signerKeyId } = {}
) {
  if (!validReceipt(receipt)) return false;
  if (signerKeyId !== undefined &&
      signerKeyId !== receipt.signer_key_id) return false;
  if (publicKey === undefined) return true;
  if (receipt.signature === null) return false;
  const { signature, receipt_hash: ignored, ...body } = receipt;
  try {
    return verifyBytes(
      null,
      Buffer.from(signingDigest(body), "utf8"),
      publicKey,
      Buffer.from(signature, "base64url")
    );
  } catch {
    return false;
  }
}

function signReceipt(body, signer) {
  if (signer === null) return { ...body, signature: null };
  try {
    return {
      ...body,
      signature: signBytes(
        null,
        Buffer.from(signingDigest(body), "utf8"),
        signer.privateKey
      ).toString("base64url")
    };
  } catch {
    operationFail("EG_RECEIPT_SIGNER_INVALID");
  }
}

function verifyChain(database) {
  const rows = database.prepare(
    "SELECT * FROM effect_receipts ORDER BY sequence"
  ).all();
  let previous = null;
  const receipts = rows.map((row, index) => {
    let receipt;
    try {
      receipt = JSON.parse(row.receipt_json);
    } catch {
      operationFail("EG_RECEIPT_CORRUPT");
    }
    if (row.sequence !== index + 1 ||
        row.receipt_id !== receipt.receipt_id ||
        row.operation_id !== receipt.operation_id ||
        row.issued_at !== receipt.issued_at ||
        row.previous_receipt_hash !== previous ||
        receipt.previous_receipt_hash !== previous ||
        row.receipt_hash !== receipt.receipt_hash ||
        canonicalJson(receipt) !== row.receipt_json ||
        !validReceipt(receipt)) {
      operationFail("EG_RECEIPT_CORRUPT");
    }
    previous = receipt.receipt_hash;
    return receipt;
  });
  const head = database.prepare(
    "SELECT * FROM effect_receipt_chain_head WHERE singleton=1"
  ).get();
  if (!head || head.receipt_count !== rows.length ||
      head.receipt_hash !== previous) {
    operationFail("EG_RECEIPT_CORRUPT");
  }
  return receipts;
}

export function issueEffectReceipt(database, {
  receiptId, operationId, issuedAt, signer = null
} = {}) {
  if (!boundedOperationValue(
    receiptId, 128, OPERATION_PATTERNS.identifier
  ) || !boundedOperationValue(
    operationId, 128, OPERATION_PATTERNS.identifier
  ) || !canonicalTimestamp(issuedAt)) {
    throw new TypeError("invalid effect receipt request");
  }
  if (signer !== null &&
      (!exactObject(signer, ["keyId", "privateKey"]) ||
        !boundedOperationValue(signer.keyId, 256))) {
    operationFail("EG_RECEIPT_SIGNER_INVALID");
  }
  const receipts = verifyChain(database);
  if (database.prepare(`SELECT 1 FROM effect_receipts
    WHERE receipt_id=? OR operation_id=?`).get(receiptId, operationId)) {
    operationFail("EG_RECEIPT_ALREADY_EXISTS");
  }
  const base = loadOperation(database, operationId);
  if (!base) operationFail("EG_OPERATION_NOT_FOUND");
  const loaded = loadOperationReconciliation(database, base);
  const operation = loaded.operation;
  if (!TERMINAL_STATES.has(operation.state)) {
    operationFail("EG_RECEIPT_NOT_READY");
  }
  const finalEvent = loaded.events.at(-1);
  const evidenceDigest = operation.reconciliation?.outcome?.outcome_digest ??
    finalEvent.evidence_ref;
  if (!OPERATION_PATTERNS.digest.test(evidenceDigest ?? "")) {
    operationFail("EG_RECEIPT_EVIDENCE_INVALID");
  }
  const signerKeyId = signer?.keyId ?? null;
  const body = {
    schema_version: "1.0.0",
    receipt_id: receiptId,
    operation_id: operationId,
    principal_id: operation.principal_id,
    client_id: operation.client_id,
    session_id: operation.session_id,
    transaction_id: operation.transaction_id,
    skill_id: operation.skill_id,
    skill_digest: operation.skill_digest,
    phase: operation.phase,
    phase_revision: operation.phase_revision,
    capsule_digest: operation.capsule_digest,
    capability_id: operation.capability_id,
    capability_revision: operation.capability_revision,
    effect_class: operation.effect_class,
    intent_digest: operation.intent_digest,
    canonical_arguments_hash: operation.canonical_arguments_hash,
    resource_scope_digest: digest(
      "effectgate.resource-scope.v1", operation.resource_scope
    ),
    disclosure_digest: operation.disclosure_digest,
    policy_revision: operation.policy_revision,
    approval_proof_digest: operation.approval_proof_digest,
    dispatch_digest: operation.dispatch_digest,
    idempotency_key_digest: operation.idempotency?.key_hash ?? null,
    safe_summary: `${operation.effect_class}:${operation.state}`,
    verification_evidence_digest: evidenceDigest,
    final_state: operation.state,
    certainty: operation.certainty,
    event_chain_head: operation.last_event_digest,
    operation_created_at: operation.created_at,
    finalized_at: finalEvent.observed_at,
    issued_at: issuedAt,
    previous_receipt_hash: receipts.at(-1)?.receipt_hash ?? null,
    signer_key_id: signerKeyId
  };
  const signed = signReceipt(body, signer);
  const receipt = {
    ...signed,
    receipt_hash: receiptHash({ ...signed, receipt_hash: null })
  };
  if (!validReceipt(receipt)) operationFail("EG_RECEIPT_INVALID");
  const sequence = receipts.length + 1;
  database.prepare(`INSERT INTO effect_receipts
    (sequence, receipt_id, operation_id, issued_at, previous_receipt_hash,
     receipt_hash, receipt_json) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
    sequence, receiptId, operationId, issuedAt,
    receipt.previous_receipt_hash, receipt.receipt_hash,
    canonicalJson(receipt)
  );
  const changed = database.prepare(`UPDATE effect_receipt_chain_head
    SET receipt_count=?, receipt_hash=?
    WHERE singleton=1 AND receipt_count=?`).run(
    sequence, receipt.receipt_hash, receipts.length
  ).changes;
  if (changed !== 1) operationFail("EG_RECEIPT_CORRUPT");
  return deepFreeze(receipt);
}

export function loadEffectReceipt(database, receiptId) {
  if (!boundedOperationValue(
    receiptId, 128, OPERATION_PATTERNS.identifier
  )) {
    throw new TypeError("invalid effect receipt ID");
  }
  // ponytail: O(n) verification keeps one authoritative chain; add
  // checkpoints only if receipt volume makes full validation measurable.
  const receipt = verifyChain(database).find(
    ({ receipt_id: id }) => id === receiptId
  );
  return receipt ? deepFreeze(receipt) : undefined;
}
