import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { EffectOperationJournal } from "../policy/operation-journal.mjs";
import { SkillEventStore } from "../skill/skill-event-store.mjs";

export function databaseIntegrity(file) {
  if (!existsSync(file)) return "not_initialized";
  let database;
  try {
    database = new DatabaseSync(file, { readOnly: true });
    const rows = database.prepare("PRAGMA integrity_check").all();
    return rows.length === 1 && rows[0].integrity_check === "ok"
      ? "pass"
      : "fail";
  } catch {
    return "fail";
  } finally {
    database?.close();
  }
}

export function recoveryBacklog(config) {
  const file = join(config.state_directory, "effect-operations.db");
  if (!existsSync(file) || databaseIntegrity(file) !== "pass") return 0;
  const database = new DatabaseSync(file, { readOnly: true });
  try {
    return database.prepare(`SELECT COUNT(*) AS count FROM operations
      WHERE state IN ('executing','uncertain','reconciling',
        'manual_resolution')`).get().count;
  } finally {
    database.close();
  }
}

function phaseStatus(loaded) {
  const last = loaded.events.at(-1);
  if (!last) return "awaiting_capsule";
  if (last.kind === "transaction_aborted") return "aborted";
  if (last.kind === "capsule_activated") {
    return Date.parse(last.payload.expires_at) > Date.now()
      ? "active"
      : "awaiting_capsule";
  }
  return last.payload.next_phase === null
    ? last.payload.status
    : "awaiting_capsule";
}

export function inspectConfiguredStatus(config) {
  const skillFile = join(config.state_directory, "skill-events.db");
  if (!existsSync(skillFile)) {
    return {
      status: "not_initialized",
      transaction_id: config.transaction_id,
      receipt_count: 0,
      recovery_backlog: 0,
      operations: []
    };
  }
  const store = new SkillEventStore({ file: skillFile, readOnly: true });
  let loaded;
  try {
    loaded = store.load(config.transaction_id);
  } finally {
    store.close();
  }
  if (!loaded) throw new Error("configured transaction does not exist");
  const operationFile = join(
    config.state_directory, "effect-operations.db"
  );
  let rows = [];
  if (existsSync(operationFile)) {
    const journal = new EffectOperationJournal({
      file: operationFile,
      readOnly: true
    });
    try {
      rows = journal.listTransaction(config.transaction_id);
    } finally {
      journal.close();
    }
  }
  const operations = rows.map(({ operation, receipt_id }) => ({
    operation_id: operation.operation_id,
    state: operation.state,
    certainty: operation.certainty,
    receipt_id,
    updated_at: operation.updated_at
  }));
  return {
    status: phaseStatus(loaded),
    transaction_id: config.transaction_id,
    receipt_count: loaded.events.filter(
      (event) => event.kind === "phase_receipt"
    ).length,
    recovery_backlog: operations.filter((operation) =>
      ["executing", "uncertain", "reconciling", "manual_resolution"]
        .includes(operation.state)).length,
    operations
  };
}

export function inspectConfiguredReceipt(config, receiptId) {
  const file = join(config.state_directory, "effect-operations.db");
  if (!existsSync(file)) throw new Error("effect receipt does not exist");
  const journal = new EffectOperationJournal({ file, readOnly: true });
  let receipt;
  try {
    receipt = journal.loadReceipt(receiptId);
  } finally {
    journal.close();
  }
  if (!receipt || receipt.transaction_id !== config.transaction_id) {
    throw new Error("effect receipt does not exist");
  }
  return receipt;
}
