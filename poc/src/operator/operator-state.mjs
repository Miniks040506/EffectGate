import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import {
  ApprovalLeaseStore
} from "../policy/approval-lease-store.mjs";
import { verifyEffectIntent } from "../policy/effect-intent.mjs";
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

function operationIntent(operation) {
  const intent = {
    schema_version: "1.0.0",
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
    canonical_arguments_hash: operation.canonical_arguments_hash,
    resource_scope: operation.resource_scope,
    disclosure_digest: operation.disclosure_digest,
    policy_revision: operation.policy_revision,
    expires_at: operation.intent_expires_at,
    intent_digest: operation.intent_digest
  };
  verifyEffectIntent(intent);
  return intent;
}

function ownedOperation(journal, config, operationId) {
  const operation = journal.load(operationId)?.operation;
  if (operation?.transaction_id !== config.transaction_id) {
    throw new Error("effect operation does not exist");
  }
  return operation;
}

function approvalCard(operation) {
  return {
    operation_id: operation.operation_id,
    challenge_id: operation.challenge_id,
    effect_class: operation.effect_class,
    capability_id: operation.capability_id,
    capability_revision: operation.capability_revision,
    resource_scope: operation.resource_scope,
    canonical_arguments_hash: operation.canonical_arguments_hash,
    disclosure_digest: operation.disclosure_digest,
    intent_digest: operation.intent_digest,
    expires_at: operation.intent_expires_at
  };
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
    updated_at: operation.updated_at,
    approval: operation.state === "awaiting_approval"
      ? approvalCard(operation)
      : null
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

export function inspectConfiguredApproval(config, operationId) {
  const file = join(config.state_directory, "effect-operations.db");
  if (!existsSync(file)) throw new Error("effect operation does not exist");
  const journal = new EffectOperationJournal({ file, readOnly: true });
  try {
    const operation = ownedOperation(journal, config, operationId);
    if (operation.state !== "awaiting_approval") {
      throw new Error("effect operation is not awaiting approval");
    }
    return approvalCard(operation);
  } finally {
    journal.close();
  }
}

export function decideConfiguredApproval(
  config,
  operationId,
  { decision, approverId }
) {
  if (config.approval_mode !== "cli") {
    throw new Error("CLI approval is not configured");
  }
  const file = join(config.state_directory, "effect-operations.db");
  if (!existsSync(file)) throw new Error("effect operation does not exist");
  const journal = new EffectOperationJournal({ file });
  const approvals = new ApprovalLeaseStore({ file });
  try {
    const operation = ownedOperation(journal, config, operationId);
    if (operation.state !== "awaiting_approval") {
      throw new Error("effect operation is not awaiting approval");
    }
    if (decision === "deny") {
      approvals.revoke({ challengeId: operation.challenge_id });
      const denied = journal.cancel(operationId);
      return {
        status: "denied",
        operation_id: operationId,
        state: denied.state
      };
    }
    const lease = approvals.approveChallenge({
      challengeId: operation.challenge_id,
      approverId,
      channel: "cli"
    });
    // ponytail: two safe commits; combine if approval contention appears.
    const proof = approvals.admitOperation({
      leaseToken: lease.lease_token,
      intent: operationIntent(operation),
      operationId
    });
    return {
      status: "approved",
      operation_id: operationId,
      state: journal.load(operationId).operation.state,
      lease_ref: lease.lease_ref,
      approval_proof_digest: proof.approval_proof_digest,
      expires_at: lease.expires_at
    };
  } finally {
    approvals.close();
    journal.close();
  }
}

export function inspectConfiguredResolution(config, operationId) {
  const file = join(config.state_directory, "effect-operations.db");
  if (!existsSync(file)) throw new Error("effect operation does not exist");
  const journal = new EffectOperationJournal({ file, readOnly: true });
  try {
    const operation = ownedOperation(journal, config, operationId);
    if (!["uncertain", "reconciling"].includes(operation.state)) {
      throw new Error("effect operation cannot be resolved");
    }
    return {
      operation_id: operationId,
      state: operation.state,
      certainty: operation.certainty,
      effect_class: operation.effect_class,
      resource_scope: operation.resource_scope,
      recovery_reason: operation.recovery_reason,
      verification_attempts:
        operation.reconciliation?.attempts.length ?? 0,
      verification_limit:
        operation.reconciliation?.max_attempts ?? null,
      verification_deadline:
        operation.reconciliation?.deadline_at ?? null
    };
  } finally {
    journal.close();
  }
}

export function manuallyResolveConfiguredOperation(
  config,
  operationId,
  receiptId,
  note
) {
  const file = join(config.state_directory, "effect-operations.db");
  if (!existsSync(file)) throw new Error("effect operation does not exist");
  const noteDigest = `sha256:${createHash("sha256")
    .update("effectgate.operator-resolution-note.v1\0")
    .update(note)
    .digest("hex")}`;
  const journal = new EffectOperationJournal({ file });
  try {
    ownedOperation(journal, config, operationId);
    const operation = journal.requireManualResolution({
      operationId,
      evidenceDigest: noteDigest
    });
    const receipt = journal.issueReceipt({ receiptId, operationId });
    return {
      status: operation.state,
      operation_id: operationId,
      certainty: operation.certainty,
      receipt_id: receipt.receipt_id,
      receipt_hash: receipt.receipt_hash,
      note_digest: noteDigest
    };
  } finally {
    journal.close();
  }
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
