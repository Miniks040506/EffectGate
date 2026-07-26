import { createHash } from "node:crypto";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_COUNTER_NAME_LENGTH = 128;
const MAX_CALIBRATION_SAMPLES = 10_000;
const COMPUTED_BASES = new Set([
  "byte_proxy",
  "tokenizer_exact",
  "tokenizer_estimate"
]);

function validName(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_COUNTER_NAME_LENGTH
  );
}

function contentBytes(content) {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  if (content instanceof Uint8Array) return Buffer.from(content);
  throw new TypeError("token input content must be a string or Uint8Array");
}

function digest(bytes) {
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

function normalizedInput(input) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("token input must be an object");
  }
  if (
    Object.keys(input).some(
      (key) =>
        key !== "content" &&
        key !== "byteLength" &&
        key !== "inputDigest" &&
        key !== "reportedValue"
    )
  ) {
    throw new TypeError("token input contains an unsupported field");
  }

  let bytes;
  let byteLength = input.byteLength;
  let inputDigest = input.inputDigest;
  if (Object.hasOwn(input, "content")) {
    bytes = contentBytes(input.content);
    if (byteLength !== undefined && byteLength !== bytes.length) {
      throw new TypeError("token input byte length does not match content");
    }
    const derivedDigest = digest(bytes);
    if (inputDigest !== undefined && inputDigest !== derivedDigest) {
      throw new TypeError("token input digest does not match content");
    }
    byteLength = bytes.length;
    inputDigest = derivedDigest;
  }
  if (!Number.isSafeInteger(byteLength) || byteLength < 0) {
    throw new TypeError("token input byteLength must be a non-negative integer");
  }
  if (typeof inputDigest !== "string" || !DIGEST_PATTERN.test(inputDigest)) {
    throw new TypeError("token input inputDigest must be a SHA-256 digest");
  }
  return { byteLength, bytes, inputDigest, reportedValue: input.reportedValue };
}

export function createTokenCounter({
  basis,
  counterId,
  counterVersion,
  count,
  calibrationErrorBound
}) {
  if (
    basis !== "host_reported" &&
    !COMPUTED_BASES.has(basis)
  ) {
    throw new TypeError("unsupported token counter basis");
  }
  if (!validName(counterId) || !validName(counterVersion)) {
    throw new TypeError(
      "counter id and version must contain 1 through 128 characters"
    );
  }
  if (
    calibrationErrorBound !== undefined &&
    (!Number.isFinite(calibrationErrorBound) ||
      calibrationErrorBound < 0 ||
      calibrationErrorBound > 1)
  ) {
    throw new TypeError("calibrationErrorBound must be between 0 and 1");
  }
  if (
    calibrationErrorBound !== undefined &&
    basis !== "byte_proxy" &&
    basis !== "tokenizer_estimate"
  ) {
    throw new TypeError("only estimated counters may declare calibration error");
  }
  if (
    (basis === "host_reported" && count !== undefined) ||
    (COMPUTED_BASES.has(basis) && typeof count !== "function")
  ) {
    throw new TypeError("token counter implementation does not match its basis");
  }

  return Object.freeze({
    basis,
    counterId,
    counterVersion,
    calibrationErrorBound,
    measure(input) {
      const normalized = normalizedInput(input);
      let value;
      if (basis === "host_reported") {
        value = normalized.reportedValue;
      } else {
        if (normalized.reportedValue !== undefined) {
          throw new TypeError("computed counters do not accept reportedValue");
        }
        if (basis !== "byte_proxy" && normalized.bytes === undefined) {
          throw new TypeError("tokenizer counters require input content");
        }
        value = count(normalized.bytes, normalized.byteLength);
      }
      if (!Number.isSafeInteger(value) || value < 0) {
        throw new TypeError("token counter value must be a non-negative integer");
      }
      return {
        value,
        basis,
        counter_id: counterId,
        counter_version: counterVersion,
        input_digest: normalized.inputDigest,
        ...(calibrationErrorBound === undefined
          ? {}
          : { calibration_error_bound: calibrationErrorBound })
      };
    }
  });
}

export function calibrateTokenCounter(counter, referenceCounter, samples) {
  if (
    (counter?.basis !== "byte_proxy" &&
      counter?.basis !== "tokenizer_estimate") ||
    referenceCounter?.basis !== "tokenizer_exact" ||
    typeof counter?.measure !== "function" ||
    typeof referenceCounter?.measure !== "function" ||
    !Array.isArray(samples) ||
    samples.length < 1 ||
    samples.length > MAX_CALIBRATION_SAMPLES
  ) {
    throw new TypeError("invalid token counter calibration");
  }

  let calibrationErrorBound = 0;
  for (const content of samples) {
    const measured = counter.measure({ content }).value;
    const reference = referenceCounter.measure({ content }).value;
    calibrationErrorBound = Math.max(
      calibrationErrorBound,
      Math.abs(measured - reference) /
        Math.max(measured, reference, 1)
    );
  }
  return Object.freeze({
    sample_count: samples.length,
    calibration_error_bound: calibrationErrorBound,
    counter_id: counter.counterId,
    counter_version: counter.counterVersion,
    reference_counter_id: referenceCounter.counterId,
    reference_counter_version: referenceCounter.counterVersion
  });
}

export const BYTE_PROXY_COUNTER = createTokenCounter({
  basis: "byte_proxy",
  counterId: "utf8-bytes-ceil-div-4",
  counterVersion: "1",
  count: (_bytes, byteLength) => Math.ceil(byteLength / 4)
});
