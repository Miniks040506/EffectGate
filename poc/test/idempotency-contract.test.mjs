import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { IDEMPOTENCY_SCHEMA } from "../src/policy/idempotency-adapter.mjs";
import { OPERATION_SCHEMA } from "../src/policy/operation-journal-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(readFileSync(join(
  HERE, "..", "..", "contracts", "idempotency-adapter.schema.json"
), "utf8"));

test("idempotency adapter contract requires qualified replay evidence", () => {
  assert.equal(CONTRACT.additionalProperties, false);
  assert.deepEqual(
    CONTRACT.properties.key_placement.properties.target.enum,
    ["arguments", "headers"]
  );
  assert.deepEqual(
    CONTRACT.properties.qualified_scenarios.prefixItems.map(
      ({ const: scenario }) => scenario
    ),
    [
      "same_key_same_intent",
      "same_key_different_intent",
      "concurrent_duplicate_calls",
      "server_restart",
      "response_loss_after_commit"
    ]
  );
  assert.ok(CONTRACT.required.includes("qualification_evidence_digest"));
  assert.ok(CONTRACT.required.includes("adapter_digest"));
});

test("idempotency persistence is immutable and contains no bearer key", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(OPERATION_SCHEMA);
    database.exec(IDEMPOTENCY_SCHEMA);
    const columns = database.prepare(
      "PRAGMA table_info(operation_idempotency)"
    ).all().map(({ name }) => name);
    assert.deepEqual(columns, [
      "operation_id",
      "intent_digest",
      "adapter_digest",
      "key_hash",
      "key_target",
      "key_name",
      "lookup_capability_id",
      "lookup_capability_revision",
      "created_at"
    ]);
    assert.equal(columns.includes("key"), false);
    const triggers = database.prepare(`SELECT name FROM sqlite_master
      WHERE type='trigger' AND name LIKE 'operation_idempotency_%'
      ORDER BY name`).all().map(({ name }) => name);
    assert.deepEqual(triggers, [
      "operation_idempotency_no_delete",
      "operation_idempotency_no_update"
    ]);
  } finally {
    database.close();
  }
});
