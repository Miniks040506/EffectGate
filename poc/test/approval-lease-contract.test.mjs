import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import {
  APPROVAL_CHANNELS,
  APPROVAL_PATTERNS,
  APPROVAL_SCHEMA,
  approvalTokenHash
} from "../src/policy/approval-lease-contract.mjs";

test("approval contract stores only hashed single-use bearer identity", () => {
  const token = `egl_${"A".repeat(43)}`;
  assert.match(token, APPROVAL_PATTERNS.token);
  assert.match("chal_AAAAAAAAAAAAAAAAAAAAAAAA",
    APPROVAL_PATTERNS.challenge);
  assert.match("lease_0123456789abcdef01234567", APPROVAL_PATTERNS.lease);
  const hash = approvalTokenHash(token);
  assert.match(hash, APPROVAL_PATTERNS.digest);
  assert.equal(hash.includes(token), false);
  assert.ok(Object.isFrozen(APPROVAL_CHANNELS));

  const database = new DatabaseSync(":memory:");
  try {
    database.exec(APPROVAL_SCHEMA);
    const tables = database.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type='table' AND name LIKE 'approval_%' ORDER BY name
    `).all();
    assert.deepEqual(tables.map(({ name }) => name), [
      "approval_challenges",
      "approval_clock",
      "approval_leases"
    ]);
    const leaseSql = tables.find(({ name }) =>
      name === "approval_leases").sql;
    assert.match(leaseSql, /lease_hash TEXT NOT NULL UNIQUE/u);
    assert.match(leaseSql, /operation_id TEXT UNIQUE/u);
    assert.doesNotMatch(tables.map(({ sql }) => sql).join("\n"),
      /lease_token|bearer|canonical_arguments/u);
  } finally {
    database.close();
  }
});
