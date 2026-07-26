import { BYTE_PROXY_COUNTER } from "./token-counter.mjs";

const MAX_BUDGET_BYTES = 256 * 1024 * 1024;
const MAX_BUDGET_TOKENS = 1_000_000;
const LOCAL_COUNTER_BASES = new Set([
  "byte_proxy",
  "tokenizer_exact",
  "tokenizer_estimate"
]);
const OVERFLOW_POLICIES = new Set([
  "none",
  "projected",
  "paged",
  "failed",
  "bounded_passthrough"
]);

export class ResultBudgetError extends RangeError {
  constructor() {
    super("result exceeds its configured budget");
    this.name = "ResultBudgetError";
  }
}

function validLimit(value, maximum) {
  return (
    Number.isSafeInteger(value) &&
    value >= 1 &&
    value <= maximum
  );
}

function contentBytes(content) {
  if (typeof content === "string") return Buffer.byteLength(content, "utf8");
  if (content instanceof Uint8Array) return content.byteLength;
  throw new TypeError("budgeted content must be a string or Uint8Array");
}

export function createResultBudgetController({
  counter = BYTE_PROXY_COUNTER,
  firstViewBytes,
  firstViewTokens,
  pageBytes,
  pageTokens
}) {
  if (
    typeof counter?.measure !== "function" ||
    !LOCAL_COUNTER_BASES.has(counter.basis) ||
    !validLimit(firstViewBytes, MAX_BUDGET_BYTES) ||
    !validLimit(pageBytes, MAX_BUDGET_BYTES) ||
    !validLimit(firstViewTokens, MAX_BUDGET_TOKENS) ||
    !validLimit(pageTokens, MAX_BUDGET_TOKENS)
  ) {
    throw new TypeError("invalid result budget controller configuration");
  }

  const configured = Object.freeze({
    first_view: Object.freeze({
      maxBytes: firstViewBytes,
      maxTokens: firstViewTokens
    }),
    page: Object.freeze({
      maxBytes: pageBytes,
      maxTokens: pageTokens
    })
  });

  function limits(stage, requested = {}) {
    const ceiling = configured[stage];
    if (
      !ceiling ||
      requested === null ||
      typeof requested !== "object" ||
      Array.isArray(requested) ||
      Object.keys(requested).some(
        (key) => key !== "maxBytes" && key !== "maxTokens"
      ) ||
      (requested.maxBytes !== undefined &&
        !validLimit(requested.maxBytes, MAX_BUDGET_BYTES)) ||
      (requested.maxTokens !== undefined &&
        !validLimit(requested.maxTokens, MAX_BUDGET_TOKENS))
    ) {
      throw new TypeError("invalid result budget request");
    }

    const maxTokens = Math.min(
      ceiling.maxTokens,
      requested.maxTokens ?? ceiling.maxTokens
    );
    let maxBytes = Math.min(
      ceiling.maxBytes,
      requested.maxBytes ?? ceiling.maxBytes
    );
    if (counter.basis === "byte_proxy") {
      maxBytes = Math.min(maxBytes, maxTokens * 4);
    }
    return Object.freeze({ maxBytes, maxTokens });
  }

  return Object.freeze({
    counter,
    limits,
    measure(stage, content, { overflow = "none", ...requested } = {}) {
      if (!OVERFLOW_POLICIES.has(overflow)) {
        throw new TypeError("invalid result budget overflow policy");
      }
      const limit = limits(stage, requested);
      const appliedBytes = contentBytes(content);
      const tokenCount = counter.measure({ content });
      if (
        appliedBytes > limit.maxBytes ||
        tokenCount.value > limit.maxTokens
      ) {
        throw new ResultBudgetError();
      }
      return Object.freeze({
        budget: Object.freeze({
          max_tokens: limit.maxTokens,
          max_bytes: limit.maxBytes,
          applied_tokens: tokenCount.value,
          applied_bytes: appliedBytes,
          overflow
        }),
        tokenCount
      });
    }
  });
}
