import { BYTE_PROXY_COUNTER } from "./token-counter.mjs";

export const MAX_SESSION_EMITTED_TOKENS = 1_000_000;

const LOCAL_COUNTER_BASES = new Set([
  "byte_proxy",
  "tokenizer_exact",
  "tokenizer_estimate"
]);

export class SessionOutputLimitError extends RangeError {
  constructor() {
    super("local session emitted-output limit is exhausted");
    this.name = "SessionOutputLimitError";
  }
}

function contentBytes(content) {
  if (typeof content === "string") return Buffer.from(content, "utf8");
  if (content instanceof Uint8Array) return Buffer.from(content);
  throw new TypeError("session output must be a string or Uint8Array");
}

export function createSessionOutputGuard({
  counter = BYTE_PROXY_COUNTER,
  maxTokens
}) {
  if (
    typeof counter?.measure !== "function" ||
    !LOCAL_COUNTER_BASES.has(counter.basis) ||
    !Number.isSafeInteger(maxTokens) ||
    maxTokens < 1 ||
    maxTokens > MAX_SESSION_EMITTED_TOKENS
  ) {
    throw new TypeError("invalid session output guard configuration");
  }

  let emittedBytes = 0;
  let emittedTokens = 0;

  function snapshot() {
    return Object.freeze({
      max_tokens: maxTokens,
      emitted_tokens: emittedTokens,
      emitted_bytes: emittedBytes,
      remaining_tokens: maxTokens - emittedTokens,
      measurement_basis: counter.basis,
      counter_id: counter.counterId,
      counter_version: counter.counterVersion,
      scope: "effectgate_model_visible_tool_output",
      host_total_context_measured: false
    });
  }

  return Object.freeze({
    admit(content, beforeCommit = () => {}) {
      if (typeof beforeCommit !== "function") {
        throw new TypeError("session output commit hook must be a function");
      }
      const bytes = contentBytes(content);
      const measured = counter.measure({ content: bytes });
      if (emittedTokens + measured.value > maxTokens) {
        throw new SessionOutputLimitError();
      }
      const admission = Object.freeze({
        bytes: bytes.length,
        token_count: measured
      });
      beforeCommit(admission);
      emittedBytes += bytes.length;
      emittedTokens += measured.value;
      return Object.freeze({
        ...admission,
        session: snapshot()
      });
    },
    snapshot
  });
}
