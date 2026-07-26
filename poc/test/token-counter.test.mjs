import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  BYTE_PROXY_COUNTER,
  calibrateTokenCounter,
  createTokenCounter
} from "../src/budget/token-counter.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(
  readFileSync(
    join(HERE, "..", "..", "contracts", "token-ledger.schema.json"),
    "utf8"
  )
).$defs.tokenCount;

function assertContract(value) {
  assert.deepEqual(
    Object.keys(value).filter(
      (key) => !Object.hasOwn(CONTRACT.properties, key)
    ),
    []
  );
  for (const key of CONTRACT.required) assert.ok(Object.hasOwn(value, key));
  assert.ok(CONTRACT.properties.basis.enum.includes(value.basis));
  assert.match(value.input_digest, /^sha256:[a-f0-9]{64}$/u);
  assert.ok(Number.isSafeInteger(value.value) && value.value >= 0);
}

test("byte-proxy counts remain deterministic with or without retained input", () => {
  const fromContent = BYTE_PROXY_COUNTER.measure({ content: "😀abc" });
  const fromMetadata = BYTE_PROXY_COUNTER.measure({
    byteLength: 7,
    inputDigest: fromContent.input_digest
  });

  assert.equal(fromContent.value, 2);
  assert.deepEqual(fromMetadata, fromContent);
  assertContract(fromContent);
  assert.throws(
    () =>
      BYTE_PROXY_COUNTER.measure({
        content: "different",
        inputDigest: fromContent.input_digest
      }),
    /digest does not match/
  );
});

test("exact, estimated, and host-reported counters preserve their basis", () => {
  const exact = createTokenCounter({
    basis: "tokenizer_exact",
    counterId: "fixture-words",
    counterVersion: "1",
    count(bytes) {
      const text = bytes.toString("utf8").trim();
      return text === "" ? 0 : text.split(/\s+/u).length;
    }
  });
  const estimate = createTokenCounter({
    basis: "tokenizer_estimate",
    counterId: "fixture-bytes",
    counterVersion: "1",
    count: (_bytes, byteLength) => Math.ceil(byteLength / 4),
    calibrationErrorBound: 0.25
  });
  const host = createTokenCounter({
    basis: "host_reported",
    counterId: "fixture-host",
    counterVersion: "2026-07-26"
  });

  const exactCount = exact.measure({ content: "one two three" });
  const estimatedCount = estimate.measure({ content: "one two three" });
  const hostCount = host.measure({
    content: "one two three",
    reportedValue: 9
  });

  assert.equal(exactCount.value, 3);
  assert.equal(exactCount.basis, "tokenizer_exact");
  assert.equal(estimatedCount.value, 4);
  assert.equal(estimatedCount.basis, "tokenizer_estimate");
  assert.equal(estimatedCount.calibration_error_bound, 0.25);
  assert.equal(hostCount.value, 9);
  assert.equal(hostCount.basis, "host_reported");
  for (const value of [exactCount, estimatedCount, hostCount]) {
    assertContract(value);
  }
});

test("calibration reports a bounded deterministic disagreement", () => {
  const exact = createTokenCounter({
    basis: "tokenizer_exact",
    counterId: "fixture-words",
    counterVersion: "1",
    count(bytes) {
      const text = bytes.toString("utf8").trim();
      return text === "" ? 0 : text.split(/\s+/u).length;
    }
  });
  const estimate = createTokenCounter({
    basis: "tokenizer_estimate",
    counterId: "fixture-byte-estimate",
    counterVersion: "1",
    count: (_bytes, byteLength) => Math.ceil(byteLength / 4)
  });
  const calibration = calibrateTokenCounter(
    estimate,
    exact,
    ["a", "one two three", "two words"]
  );

  assert.equal(calibration.sample_count, 3);
  assert.equal(calibration.calibration_error_bound, 1 / 3);
  assert.equal(calibration.counter_id, "fixture-byte-estimate");
  assert.equal(calibration.reference_counter_id, "fixture-words");
  assert.equal(
    createTokenCounter({
      basis: "tokenizer_estimate",
      counterId: "fixture-byte-estimate",
      counterVersion: "1",
      count: (_bytes, byteLength) => Math.ceil(byteLength / 4),
      calibrationErrorBound: calibration.calibration_error_bound
    }).measure({ content: "two words" }).calibration_error_bound,
    1 / 3
  );
});

test("counter trust boundaries reject ambiguous or invalid measurements", () => {
  const exact = createTokenCounter({
    basis: "tokenizer_exact",
    counterId: "fixture-exact",
    counterVersion: "1",
    count: () => 1
  });
  const host = createTokenCounter({
    basis: "host_reported",
    counterId: "fixture-host",
    counterVersion: "1"
  });

  assert.throws(
    () =>
      exact.measure({
        byteLength: 4,
        inputDigest: `sha256:${"0".repeat(64)}`
      }),
    /require input content/
  );
  assert.throws(
    () => host.measure({ content: "input", reportedValue: -1 }),
    /non-negative integer/
  );
  assert.throws(
    () =>
      createTokenCounter({
        basis: "tokenizer_exact",
        counterId: "broken",
        counterVersion: "1",
        count: () => 1.5
      }).measure({ content: "input" }),
    /non-negative integer/
  );
  assert.throws(
    () =>
      createTokenCounter({
        basis: "host_reported",
        counterId: "broken",
        counterVersion: "1",
        count: () => 1
      }),
    /does not match its basis/
  );
  assert.throws(
    () => calibrateTokenCounter(exact, exact, ["input"]),
    /invalid token counter calibration/
  );
});
