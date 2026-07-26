import assert from "node:assert/strict";
import test from "node:test";

import {
  SessionOutputLimitError,
  createSessionOutputGuard
} from "../src/budget/session-output-guard.mjs";
import { createTokenCounter } from "../src/budget/token-counter.mjs";

test("session output accounting counts replays and rejects atomically", () => {
  const guard = createSessionOutputGuard({ maxTokens: 3 });

  guard.admit("same");
  guard.admit("same");
  assert.deepEqual(guard.snapshot(), {
    max_tokens: 3,
    emitted_tokens: 2,
    emitted_bytes: 8,
    remaining_tokens: 1,
    measurement_basis: "byte_proxy",
    counter_id: "utf8-bytes-ceil-div-4",
    counter_version: "1",
    scope: "effectgate_model_visible_tool_output",
    host_total_context_measured: false
  });

  assert.throws(
    () => guard.admit("overflow"),
    SessionOutputLimitError
  );
  assert.throws(
    () =>
      guard.admit("fits", () => {
        throw new Error("ledger unavailable");
      }),
    /ledger unavailable/
  );
  assert.equal(guard.snapshot().emitted_tokens, 2);
  assert.equal(guard.snapshot().emitted_bytes, 8);
});

test("session guards are isolated and accept local tokenizer counters", () => {
  const exact = createTokenCounter({
    basis: "tokenizer_exact",
    counterId: "fixture-codepoints",
    counterVersion: "1",
    count: (bytes) => [...bytes.toString("utf8")].length
  });
  const first = createSessionOutputGuard({
    counter: exact,
    maxTokens: 2
  });
  const second = createSessionOutputGuard({
    counter: exact,
    maxTokens: 2
  });

  first.admit("二字");
  assert.equal(first.snapshot().remaining_tokens, 0);
  assert.equal(second.snapshot().emitted_tokens, 0);
  assert.throws(() => first.admit("x"), SessionOutputLimitError);
});

test("session output guard rejects ambiguous configuration and input", () => {
  const reported = createTokenCounter({
    basis: "host_reported",
    counterId: "fixture-host",
    counterVersion: "1"
  });

  assert.throws(
    () => createSessionOutputGuard({ maxTokens: 0 }),
    /invalid session output guard configuration/
  );
  assert.throws(
    () =>
      createSessionOutputGuard({
        counter: reported,
        maxTokens: 1
      }),
    /invalid session output guard configuration/
  );
  assert.throws(
    () => createSessionOutputGuard({ maxTokens: 1 }).admit({}),
    /session output must be/
  );
});
