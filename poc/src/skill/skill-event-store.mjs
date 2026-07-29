import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { canonicalJson, deepFreeze } from "./passport-compiler.mjs";
import { SkillSourceError } from "./source-import.mjs";
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,127}$/u;
const EVENT_KINDS = new Set([
  "capsule_activated", "phase_receipt", "transaction_aborted"
]);
const MAX_PAYLOAD_BYTES = 1024 * 1024;
export class CorruptSkillEventStoreError extends Error {
  constructor(message = "skill event store failed integrity validation") {
    super(message);
    this.name = "CorruptSkillEventStoreError";
    this.code = "EG_SKILL_DIGEST_DRIFT";
  }
}
function fail(message) {
  throw new SkillSourceError("EG_SKILL_SOURCE_INVALID", message);
}
function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}
function timestamp(value, label) {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) {
    fail(`${label} must be a timestamp`);
  }
  return value;
}

function identifier(value, label, pattern = NAME_PATTERN) {
  if (typeof value !== "string" || !pattern.test(value)) {
    fail(`${label} is invalid`);
  }
  return value;
}

function eventDigest(event) {
  return digest(`effectgate.skill-event.v1\0${canonicalJson(event)}`);
}

const SCHEMA = `
PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS skill_transactions (
  transaction_id TEXT PRIMARY KEY, passport_digest TEXT NOT NULL, skill_digest
  TEXT NOT NULL, initial_phase TEXT NOT NULL, created_at TEXT NOT NULL,
  transaction_digest TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS skill_phase_events (
  transaction_id TEXT NOT NULL, sequence INTEGER NOT NULL, kind TEXT NOT NULL, phase
  TEXT NOT NULL, phase_revision INTEGER NOT NULL, payload_json TEXT NOT NULL,
  payload_digest TEXT NOT NULL, previous_digest TEXT, observed_at TEXT NOT NULL,
  event_digest TEXT NOT NULL UNIQUE, PRIMARY KEY (transaction_id, sequence), FOREIGN
  KEY (transaction_id) REFERENCES skill_transactions(transaction_id)
) STRICT;
CREATE TRIGGER IF NOT EXISTS skill_transactions_no_update BEFORE UPDATE ON skill_transactions BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER IF NOT EXISTS skill_transactions_no_delete BEFORE DELETE ON skill_transactions BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER IF NOT EXISTS skill_phase_events_no_update BEFORE UPDATE ON skill_phase_events BEGIN SELECT RAISE(ABORT, 'immutable'); END;
CREATE TRIGGER IF NOT EXISTS skill_phase_events_no_delete BEFORE DELETE ON skill_phase_events BEGIN SELECT RAISE(ABORT, 'immutable'); END;
PRAGMA user_version=1;
`;

export class SkillEventStore {
  #database;

  constructor({ file, readOnly = false } = {}) {
    if (typeof file !== "string" || file.length < 1) {
      fail("event store file must be a non-empty path");
    }
    if (typeof readOnly !== "boolean") {
      fail("event store readOnly must be boolean");
    }
    const databaseFile = resolve(file);
    if (!readOnly) {
      mkdirSync(dirname(databaseFile), { recursive: true, mode: 0o700 });
    }
    this.#database = new DatabaseSync(databaseFile, { readOnly });
    if (!readOnly) this.#database.exec(SCHEMA);
  }

  startTransaction({ transactionId, passportDigest, skillDigest,
    initialPhase, createdAt } = {}) {
    identifier(transactionId, "transactionId",
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
    identifier(passportDigest, "passportDigest", DIGEST_PATTERN);
    identifier(skillDigest, "skillDigest", DIGEST_PATTERN);
    identifier(initialPhase, "initialPhase");
    timestamp(createdAt, "createdAt");
    const header = { transaction_id: transactionId,
      passport_digest: passportDigest,
      skill_digest: skillDigest, initial_phase: initialPhase, created_at: createdAt
    };
    const transactionDigest = digest(`effectgate.skill-transaction.v1\0${
      canonicalJson(header)}`);
    try {
      this.#database.prepare(`
        INSERT INTO skill_transactions (transaction_id, passport_digest,
          skill_digest, initial_phase, created_at, transaction_digest)
          VALUES (?, ?, ?, ?, ?, ?)
      `).run(transactionId, passportDigest, skillDigest, initialPhase, createdAt,
        transactionDigest);
    } catch {
      fail("transaction already exists or could not be persisted");
    }
  }

  append({ transactionId, kind, phase, phaseRevision, payload,
    observedAt } = {}) {
    identifier(transactionId, "transactionId",
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
    identifier(phase, "phase");
    if (!EVENT_KINDS.has(kind) ||
        !Number.isSafeInteger(phaseRevision) || phaseRevision < 1) {
      fail("event kind or phase revision is invalid");
    }
    timestamp(observedAt, "observedAt");
    let payloadJson;
    let persistedPayload;
    try {
      payloadJson = canonicalJson(payload);
      persistedPayload = JSON.parse(payloadJson);
    } catch {
      fail("event payload must be canonical JSON");
    }
    if (typeof payloadJson !== "string" ||
        Buffer.byteLength(payloadJson) > MAX_PAYLOAD_BYTES) {
      fail("event payload exceeds byte limit");
    }
    const payloadDigest = digest(payloadJson);

    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.#database.prepare(`
        SELECT sequence, event_digest FROM skill_phase_events
        WHERE transaction_id=? ORDER BY sequence DESC LIMIT 1
      `).get(transactionId);
      const sequence = (previous?.sequence ?? 0) + 1;
      const anchor = previous?.event_digest ?? this.#database.prepare(
        "SELECT transaction_digest FROM skill_transactions WHERE transaction_id=?"
      ).get(transactionId)?.transaction_digest;
      if (!anchor) fail("event transaction does not exist");
      const header = {
        transaction_id: transactionId,
        sequence,
        kind,
        phase,
        phase_revision: phaseRevision,
        payload_digest: payloadDigest,
        previous_digest: anchor,
        observed_at: observedAt
      };
      const chainedDigest = eventDigest(header);
      this.#database.prepare(`
        INSERT INTO skill_phase_events (transaction_id, sequence, kind, phase,
          phase_revision, payload_json, payload_digest, previous_digest,
          observed_at, event_digest)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        transactionId, sequence, kind, phase, phaseRevision, payloadJson,
        payloadDigest, header.previous_digest, observedAt, chainedDigest
      );
      this.#database.exec("COMMIT");
      return deepFreeze({ ...header, event_digest: chainedDigest,
        payload: persistedPayload });
    } catch (error) {
      this.#database.exec("ROLLBACK");
      if (error instanceof SkillSourceError) throw error;
      fail("event could not be appended");
    }
  }

  load(transactionId) {
    identifier(transactionId, "transactionId",
      /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u);
    const transaction = this.#database.prepare(
      "SELECT * FROM skill_transactions WHERE transaction_id=?"
    ).get(transactionId);
    if (!transaction) return undefined;
    const { transaction_digest: claimed, ...header } = transaction;
    if (digest(`effectgate.skill-transaction.v1\0${canonicalJson(header)}`) !==
        claimed) {
      throw new CorruptSkillEventStoreError();
    }
    const rows = this.#database.prepare(
      "SELECT * FROM skill_phase_events WHERE transaction_id=? ORDER BY sequence"
    ).all(transactionId);
    let previous = claimed;
    const events = rows.map((row, index) => {
      let payload;
      try {
        payload = JSON.parse(row.payload_json);
      } catch {
        throw new CorruptSkillEventStoreError();
      }
      const header = {
        transaction_id: row.transaction_id,
        sequence: row.sequence,
        kind: row.kind,
        phase: row.phase,
        phase_revision: row.phase_revision,
        payload_digest: row.payload_digest,
        previous_digest: row.previous_digest,
        observed_at: row.observed_at
      };
      if (row.sequence !== index + 1 ||
          row.previous_digest !== previous ||
          digest(canonicalJson(payload)) !== row.payload_digest ||
          eventDigest(header) !== row.event_digest) {
        throw new CorruptSkillEventStoreError();
      }
      previous = row.event_digest;
      return { ...header, event_digest: row.event_digest, payload };
    });
    return deepFreeze({ transaction: { ...transaction }, events });
  }

  close() {
    this.#database.close();
  }
}
