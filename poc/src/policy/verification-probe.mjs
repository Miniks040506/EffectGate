import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";

import { canonicalArgumentsHash } from "./effect-intent.mjs";
import { verifyIdempotencyBinding } from "./idempotency-adapter.mjs";
import {
  OPERATION_PATTERNS,
  boundedOperationValue
} from "./operation-journal-contract.mjs";
import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";
import {
  VerificationProbeError,
  verifyVerificationProbe
} from "./verification-probe-contract.mjs";

export {
  VerificationProbeError,
  compileVerificationProbe,
  verifyVerificationProbe
} from "./verification-probe-contract.mjs";

function fail(code) {
  throw new VerificationProbeError(code);
}

function exactObject(value, keys, code) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
      Reflect.ownKeys(value).length !== keys.length ||
      keys.some((key) => {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        return !descriptor?.enumerable || !Object.hasOwn(descriptor, "value");
      })) {
    fail(code);
  }
}

function digest(domain, value) {
  return `sha256:${createHash("sha256")
    .update(`${domain}\0`)
    .update(canonicalJson(value))
    .digest("hex")}`;
}

function scalar(value) {
  return value === null || typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    boundedOperationValue(value, 1024);
}

const MISSING = Symbol("missing");

function operationSources(descriptor, operation, idempotency) {
  if (!operation || operation.schema_version !== "1.0.0" ||
      !["executing", "uncertain", "reconciling"].includes(operation.state) ||
      operation.capability_id !== descriptor.capability_id ||
      operation.capability_revision !== descriptor.capability_revision ||
      !OPERATION_PATTERNS.identifier.test(operation.operation_id ?? "") ||
      !OPERATION_PATTERNS.digest.test(operation.intent_digest ?? "") ||
      !OPERATION_PATTERNS.digest.test(
        operation.canonical_arguments_hash ?? ""
      ) ||
      !boundedOperationValue(operation.transaction_id, 128) ||
      !operation.resource_scope ||
      !["exact", "prefix"].includes(operation.resource_scope.kind) ||
      !boundedOperationValue(operation.resource_scope.value, 2048)) {
    fail("EG_VERIFICATION_OPERATION_MISMATCH");
  }
  const values = {
    intent_digest: operation.intent_digest,
    canonical_arguments_hash: operation.canonical_arguments_hash,
    resource_scope_kind: operation.resource_scope.kind,
    resource_scope_value: operation.resource_scope.value,
    capability_id: operation.capability_id,
    capability_revision: operation.capability_revision,
    transaction_id: operation.transaction_id
  };
  const needsKey = descriptor.arguments.some(
    ({ source }) => source === "idempotency_key"
  ) || Object.values(descriptor.predicates).flat().some(
    ({ equals }) => equals.source === "idempotency_key"
  );
  if (needsKey) {
    if (!idempotency?.adapter || !idempotency?.binding) {
      fail("EG_VERIFICATION_OPERATION_MISMATCH");
    }
    try {
      verifyIdempotencyBinding({ ...idempotency, operation });
    } catch {
      fail("EG_VERIFICATION_OPERATION_MISMATCH");
    }
    if (idempotency.adapter.lookup.capability_id !==
        descriptor.probe.capability_id ||
        idempotency.adapter.lookup.capability_revision !==
          descriptor.probe.capability_revision) {
      fail("EG_VERIFICATION_OPERATION_MISMATCH");
    }
    values.idempotency_key = idempotency.binding.key;
  }
  return values;
}

function readPointer(value, path) {
  let current = value;
  for (const part of path.slice(1).split("/")) {
    const segment = part.replaceAll("~1", "/").replaceAll("~0", "~");
    if (!current || typeof current !== "object" ||
        !Object.hasOwn(current, segment)) {
      return MISSING;
    }
    current = current[segment];
  }
  return current;
}

function predicateMatches(data, predicates, sources) {
  return predicates.every(({ path, equals }) => {
    const actual = readPointer(data, path);
    const expected = Object.hasOwn(equals, "source")
      ? sources[equals.source]
      : equals.literal;
    return actual !== MISSING && scalar(actual) &&
      canonicalJson(actual) === canonicalJson(expected);
  });
}

function classify(data, descriptor, sources) {
  const matched = Object.entries(descriptor.predicates)
    .filter(([, predicates]) =>
      predicateMatches(data, predicates, sources))
    .map(([outcome]) => outcome);
  return matched.length === 1 ? matched[0] : "ambiguous";
}

function validateResult(result, maximum) {
  exactObject(result, [
    "data", "evidence_ref", "evidence_digest"
  ], "EG_VERIFICATION_RESULT_INVALID");
  if (!boundedOperationValue(result.evidence_ref, 1024) ||
      !OPERATION_PATTERNS.digest.test(result.evidence_digest ?? "")) {
    fail("EG_VERIFICATION_RESULT_INVALID");
  }
  try {
    canonicalArgumentsHash(result.data);
  } catch {
    fail("EG_VERIFICATION_RESULT_INVALID");
  }
  const resultJson = canonicalJson(result.data);
  if (Buffer.byteLength(resultJson, "utf8") > maximum) {
    fail("EG_VERIFICATION_RESULT_TOO_LARGE");
  }
  return {
    data: result.data,
    evidence_ref: result.evidence_ref,
    evidence_digest: result.evidence_digest,
    result_digest: digest("effectgate.verification-result.v1", result.data)
  };
}

class ProbeTimeoutError extends Error {}

async function invokeWithin(invoke, request, timeoutMs) {
  const controller = new AbortController();
  let timer;
  try {
    return await Promise.race([
      Promise.resolve().then(() =>
        invoke(request, { signal: controller.signal })),
      new Promise((resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new ProbeTimeoutError());
        }, timeoutMs);
      })
    ]);
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

function finish(descriptor, operation, outcome, attempts, windowSatisfied) {
  const body = {
    schema_version: "1.0.0",
    operation_id: operation.operation_id,
    descriptor_digest: descriptor.descriptor_digest,
    outcome,
    attempts,
    observation_window_satisfied: windowSatisfied,
    safe_reason_code: outcome === "verified_committed"
      ? "probe_proved_committed"
      : outcome === "verified_not_committed"
        ? "probe_proved_not_committed"
        : "probe_budget_exhausted"
  };
  return deepFreeze({
    ...body,
    evidence_digest: digest("effectgate.verification-run.v1", body)
  });
}

export async function runVerificationProbe({
  descriptor,
  operation,
  idempotency = null,
  invoke,
  attemptOffset = 0,
  attemptLimit = null,
  elapsedOffsetMs = 0,
  totalTimeoutMs = null,
  onAttempt = async () => {},
  now = () => performance.now(),
  sleep = (milliseconds) =>
    new Promise((resolve) => setTimeout(resolve, milliseconds))
} = {}) {
  verifyVerificationProbe(descriptor);
  const maximumAttempts = attemptLimit ?? descriptor.limits.max_attempts;
  const timeoutBudget = totalTimeoutMs ?? descriptor.limits.total_timeout_ms;
  if (typeof invoke !== "function" || typeof now !== "function" ||
      typeof sleep !== "function" || typeof onAttempt !== "function" ||
      !Number.isSafeInteger(attemptOffset) || attemptOffset < 0 ||
      !Number.isSafeInteger(maximumAttempts) || maximumAttempts < 1 ||
      attemptOffset + maximumAttempts > descriptor.limits.max_attempts ||
      !Number.isFinite(elapsedOffsetMs) || elapsedOffsetMs < 0 ||
      elapsedOffsetMs > descriptor.limits.total_timeout_ms ||
      !Number.isSafeInteger(timeoutBudget) || timeoutBudget < 1 ||
      timeoutBudget > descriptor.limits.total_timeout_ms) {
    fail("EG_VERIFICATION_RUNTIME_INVALID");
  }
  const sources = operationSources(descriptor, operation, idempotency);
  const request = deepFreeze({
    capability_id: descriptor.probe.capability_id,
    capability_revision: descriptor.probe.capability_revision,
    effect_class: "observe",
    arguments: Object.fromEntries(descriptor.arguments.map(
      ({ name, source }) => [name, sources[source]]
    ))
  });
  let previous = -1;
  const clock = () => {
    const value = now();
    if (!Number.isFinite(value) || value < 0 || value < previous) {
      fail("EG_VERIFICATION_CLOCK_INVALID");
    }
    previous = value;
    return value;
  };
  const started = clock();
  const attempts = [];
  const retain = async (record) => {
    const frozen = deepFreeze(record);
    attempts.push(frozen);
    await onAttempt(frozen);
  };
  for (let index = 1; index <= maximumAttempts; index += 1) {
    const attempt = attemptOffset + index;
    const remaining = timeoutBudget -
      (clock() - started);
    if (remaining <= 0) break;
    const timeout = Math.max(1, Math.min(
      descriptor.limits.per_attempt_timeout_ms,
      Math.floor(remaining)
    ));
    let record;
    let resultReceived = false;
    let windowSatisfied = false;
    try {
      const rawResult = await invokeWithin(invoke, request, timeout);
      resultReceived = true;
      const result = validateResult(
        rawResult,
        descriptor.limits.max_result_bytes
      );
      const classification = classify(result.data, descriptor, sources);
      const elapsed = elapsedOffsetMs + clock() - started;
      windowSatisfied = elapsed >= descriptor.limits.observation_window_ms;
      const effective = classification === "not_committed" &&
        !windowSatisfied ? "ambiguous" : classification;
      record = {
        attempt,
        classification: effective,
        evidence_ref: result.evidence_ref,
        evidence_digest: result.evidence_digest,
        result_digest: result.result_digest,
        safe_reason_code: effective === "committed"
          ? "committed_predicate_matched"
          : effective === "not_committed"
            ? "not_committed_predicate_matched"
            : classification === "not_committed"
              ? "observation_window_open"
              : "ambiguous_or_no_predicate"
      };
    } catch (error) {
      if (resultReceived && error instanceof VerificationProbeError &&
          !["EG_VERIFICATION_RESULT_INVALID",
            "EG_VERIFICATION_RESULT_TOO_LARGE"].includes(error.code)) {
        throw error;
      }
      record = {
        attempt,
        classification: "ambiguous",
        evidence_ref: null,
        evidence_digest: null,
        result_digest: null,
        safe_reason_code: error instanceof ProbeTimeoutError
          ? "probe_timeout"
          : resultReceived && error instanceof VerificationProbeError
            ? "probe_result_invalid"
            : "probe_transport_error"
      };
    }
    await retain(record);
    if (record.classification === "committed") {
      return finish(
        descriptor, operation, "verified_committed", attempts,
        windowSatisfied
      );
    }
    if (record.classification === "not_committed") {
      return finish(
        descriptor, operation, "verified_not_committed", attempts, true
      );
    }
    if (index === maximumAttempts) break;
    const backoff = Math.min(
      descriptor.limits.initial_backoff_ms * (2 ** (attempt - 1)),
      descriptor.limits.max_backoff_ms
    );
    const remainingAfter = timeoutBudget -
      (clock() - started);
    if (backoff >= remainingAfter) break;
    if (backoff > 0) await sleep(backoff);
  }
  return finish(
    descriptor,
    operation,
    "ambiguous",
    attempts,
    elapsedOffsetMs + clock() - started >=
      descriptor.limits.observation_window_ms
  );
}
