import assert from "node:assert/strict";
import test from "node:test";

import {
  ResultBudgetError,
  createResultBudgetController
} from "../src/budget/result-budget.mjs";
import { createTokenCounter } from "../src/budget/token-counter.mjs";
import { ContextStore } from "../src/context/context-view.mjs";

function controller(options = {}) {
  return createResultBudgetController({
    firstViewBytes: 8,
    firstViewTokens: 2,
    pageBytes: 4,
    pageTokens: 1,
    ...options
  });
}

test("result budgets distinguish first views from fetched pages", () => {
  const budget = controller();

  assert.deepEqual(budget.limits("first_view"), {
    maxBytes: 8,
    maxTokens: 2
  });
  assert.deepEqual(budget.limits("page"), {
    maxBytes: 4,
    maxTokens: 1
  });
  assert.deepEqual(
    budget.limits("first_view", { maxBytes: 6, maxTokens: 1 }),
    { maxBytes: 4, maxTokens: 1 }
  );
});

test("Context View applies separate first-view and page ceilings", () => {
  const store = new ContextStore({
    firstViewBytes: 8,
    firstViewTokens: 2,
    pageBytes: 4,
    pageTokens: 1
  });
  try {
    const first = store.ingest("abcdefghijkl");
    const page = store.fetch(first.retrieval.cursor);

    assert.equal(first.content, "abcdefgh");
    assert.deepEqual(first.budget, {
      max_tokens: 2,
      max_bytes: 8,
      applied_tokens: 2,
      applied_bytes: 8,
      overflow: "paged"
    });
    assert.equal(page.content, "ijkl");
    assert.deepEqual(page.budget, {
      max_tokens: 1,
      max_bytes: 4,
      applied_tokens: 1,
      applied_bytes: 4,
      overflow: "paged"
    });
  } finally {
    store.close();
  }
});

test("result budgets return one authoritative measurement envelope", () => {
  const measured = controller().measure(
    "first_view",
    "😀abc",
    { overflow: "paged" }
  );

  assert.deepEqual(measured.budget, {
    max_tokens: 2,
    max_bytes: 8,
    applied_tokens: 2,
    applied_bytes: 7,
    overflow: "paged"
  });
  assert.equal(measured.tokenCount.value, 2);
  assert.equal(measured.tokenCount.basis, "byte_proxy");
  assert.throws(
    () => controller().measure("page", "😀abc"),
    ResultBudgetError
  );
});

test("token limits fail closed for non-byte-proxy counters", () => {
  const exact = createTokenCounter({
    basis: "tokenizer_exact",
    counterId: "fixture-codepoints",
    counterVersion: "1",
    count: (bytes) => [...bytes.toString("utf8")].length
  });
  const budget = controller({
    counter: exact,
    firstViewBytes: 64,
    firstViewTokens: 2
  });

  assert.throws(
    () => budget.measure("first_view", "three"),
    ResultBudgetError
  );
  assert.equal(
    budget.measure("first_view", "二字").tokenCount.basis,
    "tokenizer_exact"
  );
});

test("result budget configuration and requests reject ambiguity", () => {
  const reported = createTokenCounter({
    basis: "host_reported",
    counterId: "fixture-host",
    counterVersion: "1"
  });
  assert.throws(
    () => controller({ pageTokens: 0 }),
    /invalid result budget controller configuration/
  );
  assert.throws(
    () => controller({ counter: reported }),
    /invalid result budget controller configuration/
  );
  assert.throws(
    () => controller().limits("unknown"),
    /invalid result budget request/
  );
  assert.throws(
    () => controller().limits("page", { maxTokens: 0 }),
    /invalid result budget request/
  );
  assert.throws(
    () =>
      controller().measure("page", "ok", {
        overflow: "invented"
      }),
    /invalid result budget overflow policy/
  );
});
