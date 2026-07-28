import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  OPERATION_CERTAINTIES,
  OPERATION_SCHEMA,
  OPERATION_STATES,
  operationCertaintyAllowed,
  operationTransitionAllowed
} from "../src/policy/operation-journal-contract.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(readFileSync(
  join(HERE, "..", "..", "contracts", "effect-operation.schema.json"),
  "utf8"
));

test("effect operation contract fixes states, certainty, and safe fields", () => {
  assert.equal(CONTRACT.additionalProperties, false);
  assert.deepEqual(CONTRACT.properties.state.enum, OPERATION_STATES);
  assert.deepEqual(CONTRACT.properties.certainty.enum, OPERATION_CERTAINTIES);
  assert.ok(CONTRACT.required.includes("intent_digest"));
  assert.ok(CONTRACT.required.includes("approval_proof_digest"));
  assert.ok(CONTRACT.required.includes("idempotency"));
  assert.ok(CONTRACT.required.includes("reconciliation"));
  assert.ok(CONTRACT.required.includes("dispatch_digest"));
  assert.equal(operationTransitionAllowed("planned", "preflighted"), true);
  assert.equal(operationTransitionAllowed("preflighted", "planned"), false);
  assert.equal(operationTransitionAllowed("uncertain", "executing"), false);
  assert.equal(operationTransitionAllowed("uncertain", "reconciling"), true);
  assert.equal(operationTransitionAllowed(
    "uncertain", "manual_resolution"
  ), true);
  assert.equal(operationTransitionAllowed(
    "reconciling", "verified_committed"
  ), true);
  assert.equal(operationTransitionAllowed(
    "manual_resolution", "executing"
  ), false);
  assert.equal(operationCertaintyAllowed("admitted", "not_started"), true);
  assert.equal(operationCertaintyAllowed("admitted", "commit_possible"), false);
  assert.equal(operationCertaintyAllowed("uncertain", "commit_possible"), true);
  assert.equal(operationCertaintyAllowed(
    "verified_committed", "verified_committed"
  ), true);
  assert.equal(operationCertaintyAllowed(
    "verified_not_committed", "commit_possible"
  ), false);
  assert.ok(Object.isFrozen(OPERATION_STATES));
  assert.ok(Object.isFrozen(OPERATION_CERTAINTIES));
});

test("operation journal schema is append-only and stores no raw arguments", () => {
  const database = new DatabaseSync(":memory:");
  try {
    database.exec(OPERATION_SCHEMA);
    const objects = database.prepare(`SELECT type, name, sql
      FROM sqlite_master WHERE name LIKE 'operation_%' OR name='operations'
      ORDER BY type, name`).all();
    assert.deepEqual(
      objects.filter(({ type }) => type === "table").map(({ name }) => name),
      ["operation_clock", "operation_events", "operations"]
    );
    assert.deepEqual(
      objects.filter(({ type }) => type === "trigger").map(({ name }) => name),
      ["operation_events_no_delete", "operation_events_no_update"]
    );
    const sql = objects.map(({ sql }) => sql).join("\n");
    assert.match(sql, /last_event_digest TEXT NOT NULL/u);
    assert.match(sql, /dispatch_digest TEXT/u);
    assert.doesNotMatch(sql, /lease_token|bearer|arguments_json|raw_arguments/u);
  } finally {
    database.close();
  }
});
