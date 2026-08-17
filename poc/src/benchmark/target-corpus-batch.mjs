#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  realpathSync
} from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { validatedHostCapture } from "./claude-capture-adapter.mjs";
import { BENCHMARK_PROFILES } from "./paired-harness.mjs";
import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";

const TASKS = Object.freeze([
  "BENCH-READ-001",
  "BENCH-JSON-002",
  "BENCH-STREAM-003",
  "BENCH-TABLE-004"
]);
const PROFILES = Object.freeze(Object.keys(BENCHMARK_PROFILES));
const REPETITIONS = 20;
const TOTAL_RUNS = TASKS.length * PROFILES.length * REPETITIONS;
const COMMIT = /^[a-f0-9]{40}$/u;
const AUTHORIZATION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const USAGE = "Usage: target-corpus-batch.mjs " +
  "init --state FILE --source-commit SHA | " +
  "claim --state FILE --authorization-id ID --limit COUNT | " +
  "record --state FILE --authorization-id ID --capture FILE | " +
  "status --state FILE";
const SCHEMA = `
  PRAGMA journal_mode=WAL;
  PRAGMA foreign_keys=ON;
  PRAGMA busy_timeout=5000;
  CREATE TABLE IF NOT EXISTS target_campaign (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    source_commit TEXT NOT NULL,
    repetitions INTEGER NOT NULL CHECK (repetitions = 20),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS target_authorizations (
    authorization_id TEXT PRIMARY KEY,
    session_limit INTEGER NOT NULL CHECK (session_limit BETWEEN 1 AND 320),
    created_at TEXT NOT NULL
  ) STRICT;
  CREATE TABLE IF NOT EXISTS target_slots (
    task_id TEXT NOT NULL,
    task_index INTEGER NOT NULL,
    repetition INTEGER NOT NULL CHECK (repetition BETWEEN 0 AND 19),
    profile TEXT NOT NULL,
    profile_index INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'claimed', 'completed')),
    authorization_id TEXT REFERENCES target_authorizations(authorization_id),
    capture_path TEXT UNIQUE,
    capture_digest TEXT UNIQUE,
    terminal_error INTEGER CHECK (terminal_error IN (0, 1)),
    recorded_at TEXT,
    PRIMARY KEY (task_id, repetition, profile)
  ) STRICT;
`;

function bounded(value, maximum = 1024) {
  return typeof value === "string" && value.length > 0 &&
    value.length <= maximum && Buffer.byteLength(value, "utf8") <= maximum * 4 &&
    !value.includes("\0");
}

function timestamp(now) {
  const value = now();
  if (!Number.isSafeInteger(value)) throw new TypeError("invalid batch clock");
  return new Date(value).toISOString();
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export class TargetCorpusBatchStore {
  #database;
  #now;

  constructor({ file, now = Date.now } = {}) {
    if (!bounded(file) || typeof now !== "function") {
      throw new TypeError("invalid target corpus batch configuration");
    }
    const absolute = resolve(file);
    mkdirSync(dirname(absolute), { recursive: true, mode: 0o700 });
    this.#database = new DatabaseSync(absolute);
    this.#database.exec(SCHEMA);
    this.#now = now;
  }

  initialize({ sourceCommit } = {}) {
    if (!COMMIT.test(sourceCommit ?? "")) {
      throw new TypeError("invalid target corpus source commit");
    }
    return this.#transaction(() => {
      const existing = this.#database.prepare(
        "SELECT source_commit FROM target_campaign WHERE singleton=1"
      ).get();
      if (existing) {
        if (existing.source_commit !== sourceCommit) {
          throw new Error("target corpus campaign source commit mismatch");
        }
        return this.status();
      }
      this.#database.prepare(`INSERT INTO target_campaign
        (singleton, source_commit, repetitions, created_at) VALUES (1, ?, ?, ?)`)
        .run(sourceCommit, REPETITIONS, timestamp(this.#now));
      const insert = this.#database.prepare(`INSERT INTO target_slots
        (task_id, task_index, repetition, profile, profile_index, status)
        VALUES (?, ?, ?, ?, ?, 'pending')`);
      for (const [taskIndex, taskId] of TASKS.entries()) {
        for (let repetition = 0; repetition < REPETITIONS; repetition += 1) {
          for (const [profileIndex, profile] of PROFILES.entries()) {
            insert.run(taskId, taskIndex, repetition, profile, profileIndex);
          }
        }
      }
      return this.status();
    });
  }

  claim({ authorizationId, limit } = {}) {
    if (!AUTHORIZATION.test(authorizationId ?? "") ||
        !Number.isSafeInteger(limit) || limit < 1 || limit > TOTAL_RUNS) {
      throw new TypeError("invalid target corpus authorization");
    }
    return this.#transaction(() => {
      this.#campaign();
      if (this.#database.prepare(
        "SELECT 1 FROM target_authorizations WHERE authorization_id=?"
      ).get(authorizationId)) throw new Error("authorization already used");
      if (this.#database.prepare(
        "SELECT 1 FROM target_slots WHERE status='claimed' LIMIT 1"
      ).get()) throw new Error("target corpus authorization still active");
      const slots = this.#database.prepare(`SELECT task_id, repetition, profile
        FROM target_slots WHERE status='pending'
        ORDER BY task_index, repetition, profile_index LIMIT ?`).all(limit);
      if (slots.length !== limit) {
        throw new Error("authorization exceeds remaining target corpus runs");
      }
      this.#database.prepare(`INSERT INTO target_authorizations
        (authorization_id, session_limit, created_at) VALUES (?, ?, ?)`)
        .run(authorizationId, limit, timestamp(this.#now));
      const update = this.#database.prepare(`UPDATE target_slots SET
        status='claimed', authorization_id=? WHERE task_id=? AND repetition=?
        AND profile=? AND status='pending'`);
      for (const slot of slots) {
        if (update.run(authorizationId, slot.task_id, slot.repetition,
          slot.profile).changes !== 1) throw new Error("target corpus claim conflict");
      }
      return deepFreeze({
        kind: "effectgate_target_corpus_authorization",
        schema_version: "1.0.0",
        authorization_id: authorizationId,
        session_limit: limit,
        slots: slots.map((slot) => ({ ...slot }))
      });
    });
  }

  record({ authorizationId, captureFile } = {}) {
    if (!AUTHORIZATION.test(authorizationId ?? "") || !bounded(captureFile)) {
      throw new TypeError("invalid target corpus capture record");
    }
    const capture = validatedHostCapture(captureFile);
    const path = realpathSync(resolve(captureFile));
    const captureDigest = digest(readFileSync(path));
    return this.#transaction(() => {
      const campaign = this.#campaign();
      if (capture.source_commit !== campaign.source_commit ||
          !TASKS.includes(capture.task_id) || capture.repetition >= REPETITIONS) {
        throw new Error("capture does not match target corpus campaign");
      }
      const changed = this.#database.prepare(`UPDATE target_slots SET
        status='completed', capture_path=?, capture_digest=?, terminal_error=?,
        recorded_at=? WHERE task_id=? AND repetition=? AND profile=?
        AND status='claimed' AND authorization_id=?`).run(
        path, captureDigest, Number(capture.terminal.is_error), timestamp(this.#now),
        capture.task_id, capture.repetition, capture.profile, authorizationId
      ).changes;
      if (changed !== 1) throw new Error("capture slot is not authorized");
      return deepFreeze({
        kind: "effectgate_target_corpus_checkpoint",
        schema_version: "1.0.0",
        authorization_id: authorizationId,
        task_id: capture.task_id,
        repetition: capture.repetition,
        profile: capture.profile,
        capture_digest: captureDigest,
        terminal_error: capture.terminal.is_error
      });
    });
  }

  status() {
    const campaign = this.#campaign();
    const counts = { pending: 0, claimed: 0, completed: 0 };
    for (const row of this.#database.prepare(
      "SELECT status, count(*) AS count FROM target_slots GROUP BY status"
    ).all()) counts[row.status] = Number(row.count);
    const active = this.#database.prepare(`SELECT s.authorization_id,
      a.session_limit, count(*) AS remaining FROM target_slots AS s
      JOIN target_authorizations AS a USING (authorization_id)
      WHERE s.status='claimed' GROUP BY s.authorization_id`).get();
    return deepFreeze({
      kind: "effectgate_target_corpus_batch_status",
      schema_version: "1.0.0",
      source_commit: campaign.source_commit,
      repetitions: campaign.repetitions,
      total_runs: TOTAL_RUNS,
      counts,
      active_authorization: active
          ? {
            authorization_id: active.authorization_id,
            session_limit: Number(active.session_limit),
            remaining: Number(active.remaining)
          }
        : null
    });
  }

  close() {
    this.#database.close();
  }

  #campaign() {
    const row = this.#database.prepare(
      "SELECT source_commit, repetitions FROM target_campaign WHERE singleton=1"
    ).get();
    if (!row) throw new Error("target corpus campaign is not initialized");
    const slots = Number(this.#database.prepare(
      "SELECT count(*) AS count FROM target_slots"
    ).get().count);
    if (row.repetitions !== REPETITIONS || slots !== TOTAL_RUNS) {
      throw new Error("target corpus campaign integrity failure");
    }
    return row;
  }

  #transaction(operation) {
    this.#database.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.#database.exec("COMMIT");
      return result;
    } catch (error) {
      try { this.#database.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }
}

function parse(args) {
  const [command, ...rest] = args;
  if (!command || rest.length % 2 !== 0) throw new Error(USAGE);
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    if (!rest[index].startsWith("--") || Object.hasOwn(values, rest[index])) {
      throw new Error(USAGE);
    }
    values[rest[index]] = rest[index + 1];
  }
  const keys = Object.keys(values).toSorted();
  const expected = {
    init: ["--source-commit", "--state"],
    claim: ["--authorization-id", "--limit", "--state"],
    record: ["--authorization-id", "--capture", "--state"],
    status: ["--state"]
  }[command];
  if (!expected || canonicalJson(keys) !== canonicalJson(expected)) {
    throw new Error(USAGE);
  }
  return { command, values };
}

export function main(args = process.argv.slice(2)) {
  const { command, values } = parse(args);
  const store = new TargetCorpusBatchStore({ file: values["--state"] });
  try {
    const result = command === "init"
      ? store.initialize({ sourceCommit: values["--source-commit"] })
      : command === "claim"
        ? store.claim({
            authorizationId: values["--authorization-id"],
            limit: Number(values["--limit"])
          })
        : command === "record"
          ? store.record({
              authorizationId: values["--authorization-id"],
              captureFile: values["--capture"]
            })
          : store.status();
    process.stdout.write(`${canonicalJson(result)}\n`);
    return result;
  } finally {
    store.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`[effectgate-target-batch] ${error.message}\n`);
    process.exitCode = 1;
  }
}
