#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
  resolveEnvironmentSecretRefs
} from "../config/layered-config.mjs";
import {
  CONTEXT_MAX_ARTIFACT_BYTES,
  CONTEXT_PAGE_BYTES,
  CONTEXT_SEARCH_MAX_CONTEXT_LINES,
  CONTEXT_SEARCH_MAX_QUERY_LENGTH,
  CONTEXT_SEARCH_MAX_TOKENS,
  CONTEXT_SEARCH_MIN_TOKENS,
  ContextRetentionError,
  ContextStore,
  InvalidArtifactError,
  InvalidCursorError,
  UnsafeArtifactError
} from "../context/context-view.mjs";
import {
  CURSOR_MAX_BYTES,
  CURSOR_PATTERN
} from "../context/cursor-service.mjs";
import {
  isValidProjectionOptions
} from "../projection/document-project.mjs";
import {
  CONTEXT_PROJECT_MAX_FIELDS,
  CONTEXT_PROJECT_MAX_LIMIT,
  CONTEXT_PROJECT_MAX_OFFSET,
  CONTEXT_PROJECT_MAX_POINTER_LENGTH,
  CONTEXT_PROJECT_MAX_TOKENS,
  CONTEXT_PROJECT_MIN_TOKENS
} from "../projection/json-project.mjs";
import {
  MAX_SESSION_EMITTED_TOKENS,
  SessionOutputLimitError,
  createSessionOutputGuard
} from "../budget/session-output-guard.mjs";
import {
  TokenLedger,
  TokenLedgerWriteError
} from "../budget/token-ledger.mjs";
import { BYTE_PROXY_COUNTER } from "../budget/token-counter.mjs";
import { canonicalJson } from "../skill/passport-compiler.mjs";
import {
  COMPACT_CALL_TOOL,
  COMPACT_DESCRIBE_TOOL,
  COMPACT_MUX_TOOLS,
  COMPACT_SEARCH_TOOL,
  compactCallArguments,
  describeCompactCapability,
  searchCompactCapabilities
} from "./compact-mux.mjs";
import {
  decideNativeDeferral,
  loadHostCompatibilityEvidence,
  withNativeDeferralMetadata
} from "./host-compatibility.mjs";
import {
  EFFECTGATE_VERSION,
  MAX_TOOL_RESULT_BYTES,
  MCP_VERSION,
  isSafeReadTool,
  isValidToolContract
} from "./mcp-contract.mjs";
import {
  FrameTooLargeError,
  MAX_FRAME_BYTES,
  backendEnvironment,
  readBoundedJsonLines,
  validateResponse,
  writeMessage
} from "./jsonl-rpc.mjs";
import {
  CHUNKED_RESULT_METHOD,
  ChunkedResultReceiver,
  boundedResponseMessages
} from "./chunked-result.mjs";
import {
  loadReviewedBackendConfig,
  verifyReviewedBackendFiles
} from "./reviewed-backend-config.mjs";

export const DEFAULT_MAX_SESSION_EMITTED_TOKENS = 256 * 1024;
export { EFFECTGATE_VERSION, MAX_TOOL_RESULT_BYTES, MCP_VERSION };
export { isSafeReadTool };
export {
  MAX_FRAME_BYTES,
  backendEnvironment,
  readBoundedJsonLines,
  validateResponse,
  writeMessage
};
export const MAX_PENDING_REQUESTS = 64;
export const FIXTURE_MAX_LINES = 100_000;
const MAX_ID_BYTES = 128;
const CURSOR_INPUT_PATTERN = new RegExp(CURSOR_PATTERN, "u");
const TOKEN_LEDGER_PROFILES = new Set([
  "native_default",
  "native_deferred",
  "compact_mux",
  "direct_bypass",
  "eager_diagnostic"
]);
const SERVE_USAGE =
  "Usage: effectgate [--version] | init|doctor|status|receipt|uninstall|" +
  "purge|backup|restore|rollback ... | fixture | " +
  "mcp skill serve --config FILE | " +
  "mcp serve [--source NAME | --config FILE] " +
  "[--max-session-emitted-tokens COUNT] [--token-ledger FILE] " +
  "[--run-id ID] [--profile PROFILE] [--host-evidence FILE]";
const SESSION_OUTPUT_LIMIT_MESSAGE =
  "EffectGate's local emitted-output limit is exhausted; " +
  "host total context usage is not measured.";
const TOKEN_LEDGER_FAILURE_MESSAGE =
  "EffectGate could not persist local token provenance.";
const contextViewProvenance = new WeakMap();

class ResultTooLargeError extends RangeError {}
class ReviewedBackendDriftError extends Error {}

function accountingFailure(error) {
  if (error instanceof SessionOutputLimitError) {
    return { code: -32008, message: SESSION_OUTPUT_LIMIT_MESSAGE };
  }
  if (error instanceof TokenLedgerWriteError) {
    return { code: -32009, message: TOKEN_LEDGER_FAILURE_MESSAGE };
  }
  return null;
}

export const FIXTURE_TOOL = Object.freeze({
  name: "echo",
  title: "Deterministic Echo",
  description: "Returns the supplied text unchanged.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { type: "string", maxLength: 4096 }
    }
  },
  outputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["text"],
    properties: {
      text: { type: "string" }
    }
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
});

export const FIXTURE_SECOND_TOOL = Object.freeze({
  ...FIXTURE_TOOL,
  name: "echo_again",
  title: "Deterministic Echo Again"
});

export const FIXTURE_LARGE_LOG_TOOL = Object.freeze({
  name: "large_log",
  title: "Deterministic Large Result",
  description: "Returns deterministic log or structured bounded-view data.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["lines"],
    properties: {
      lines: { type: "integer", minimum: 1, maximum: FIXTURE_MAX_LINES },
      format: {
        type: "string",
        enum: ["log", "jsonl", "csv", "markdown"],
        default: "log"
      },
      includeStructuredCopy: { type: "boolean" },
      includeSecrets: { type: "boolean" }
    }
  },
  annotations: FIXTURE_TOOL.annotations
});

export const FIXTURE_SECRETS = Object.freeze([
  "eg_test_K7m2P9q4R8s1T6v3W5x0",
  "bearer_K4n8Q2m6V9x3R7s1T5w0",
  "sk-effectgate-A7c3F9k2M8p4R6v1"
]);

export const CONTEXT_FETCH_TOOL = Object.freeze({
  name: "effectgate_fetch",
  title: "Fetch Context View",
  description:
    "Fetches the next bounded page using an authenticated EffectGate cursor.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["cursor"],
    properties: {
      cursor: {
        type: "string",
        minLength: 32,
        maxLength: CURSOR_MAX_BYTES,
        pattern: CURSOR_PATTERN
      }
    }
  },
  annotations: FIXTURE_TOOL.annotations
});

export const CONTEXT_SEARCH_TOOL = Object.freeze({
  name: "effectgate_search",
  title: "Search Context Artifact",
  description:
    "Returns a bounded, cited context window for a literal artifact match.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["artifact_id", "query"],
    properties: {
      artifact_id: {
        type: "string",
        pattern: "^art_[a-f0-9]{64}$"
      },
      query: {
        type: "string",
        minLength: 1,
        maxLength: CONTEXT_SEARCH_MAX_QUERY_LENGTH
      },
      context_lines: {
        type: "integer",
        minimum: 0,
        maximum: CONTEXT_SEARCH_MAX_CONTEXT_LINES,
        default: 1
      },
      max_tokens: {
        type: "integer",
        minimum: CONTEXT_SEARCH_MIN_TOKENS,
        maximum: CONTEXT_SEARCH_MAX_TOKENS,
        default: 512
      }
    }
  },
  annotations: FIXTURE_TOOL.annotations
});

export const CONTEXT_PROJECT_TOOL = Object.freeze({
  name: "effectgate_project",
  title: "Project Context Artifact",
  description:
    "Returns a bounded JSON/JSONL, CSV/TSV, or Markdown projection.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["artifact_id", "format"],
    properties: {
      artifact_id: {
        type: "string",
        pattern: "^art_[a-f0-9]{64}$"
      },
      format: {
        type: "string",
        enum: ["json", "jsonl", "csv", "tsv", "markdown"]
      },
      fields: {
        type: "array",
        maxItems: CONTEXT_PROJECT_MAX_FIELDS,
        uniqueItems: true,
        items: {
          type: "string",
          maxLength: CONTEXT_PROJECT_MAX_POINTER_LENGTH,
          pattern: "^(?:/(?:[^~]|~[01])*)*$"
        }
      },
      columns: {
        type: "array",
        maxItems: CONTEXT_PROJECT_MAX_FIELDS,
        uniqueItems: true,
        items: {
          type: "string",
          minLength: 1,
          maxLength: CONTEXT_PROJECT_MAX_POINTER_LENGTH
        }
      },
      filter: {
        type: "object",
        additionalProperties: false,
        required: ["equals"],
        oneOf: [
          { required: ["pointer"] },
          { required: ["column"] }
        ],
        properties: {
          pointer: {
            type: "string",
            maxLength: CONTEXT_PROJECT_MAX_POINTER_LENGTH,
            pattern: "^(?:/(?:[^~]|~[01])*)*$"
          },
          column: {
            type: "string",
            minLength: 1,
            maxLength: CONTEXT_PROJECT_MAX_POINTER_LENGTH
          },
          equals: {
            type: ["string", "number", "boolean", "null"]
          }
        }
      },
      heading: {
        type: "string",
        minLength: 1,
        maxLength: CONTEXT_PROJECT_MAX_POINTER_LENGTH
      },
      offset: {
        type: "integer",
        minimum: 0,
        maximum: CONTEXT_PROJECT_MAX_OFFSET,
        default: 0
      },
      limit: {
        type: "integer",
        minimum: 1,
        maximum: CONTEXT_PROJECT_MAX_LIMIT,
        default: 100
      },
      max_tokens: {
        type: "integer",
        minimum: CONTEXT_PROJECT_MIN_TOKENS,
        maximum: CONTEXT_PROJECT_MAX_TOKENS,
        default: 512
      }
    }
  },
  annotations: FIXTURE_TOOL.annotations
});

function validateFixtureArguments(lines, includeSecrets) {
  if (!Number.isSafeInteger(lines) || lines < 1 || lines > FIXTURE_MAX_LINES) {
    throw new RangeError(
      `lines must be an integer from 1 through ${FIXTURE_MAX_LINES}`
    );
  }
  if (typeof includeSecrets !== "boolean") {
    throw new TypeError("includeSecrets must be a boolean");
  }
}

export function buildFixtureLog(lines, includeSecrets = false) {
  validateFixtureArguments(lines, includeSecrets);
  return Array.from(
    { length: lines },
    (_, index) => {
      let secret = "";
      if (includeSecrets && index === 4) {
        secret = ` api_key=${FIXTURE_SECRETS[0]}`;
      } else if (includeSecrets && index === Math.floor(lines / 2)) {
        secret = ` authorization=Bearer ${FIXTURE_SECRETS[1]}`;
      } else if (includeSecrets && index === lines - 2) {
        secret = ` token=${FIXTURE_SECRETS[2]}`;
      }
      return (
        `${String(index + 1).padStart(6, "0")} level=INFO component=fixture ` +
        `message="bounded context evidence" marker=✓${secret}\n`
      );
    }
  ).join("");
}

export function buildFixtureJsonl(lines, includeSecrets = false) {
  validateFixtureArguments(lines, includeSecrets);
  return Array.from({ length: lines }, (_, index) => {
    const record = {
      line: index + 1,
      level: index % 5 === 0 ? "WARN" : "INFO",
      component: "fixture",
      details: {
        message: "bounded context evidence",
        marker: "✓"
      }
    };
    if (includeSecrets && index === 4) record.api_key = FIXTURE_SECRETS[0];
    if (includeSecrets && index === Math.floor(lines / 2)) {
      record.authorization = `Bearer ${FIXTURE_SECRETS[1]}`;
    }
    if (includeSecrets && index === lines - 2) {
      record.token = FIXTURE_SECRETS[2];
    }
    return `${JSON.stringify(record)}\n`;
  }).join("");
}

function csvCell(value) {
  return /[",\r\n]/u.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

export function buildFixtureCsv(lines, includeSecrets = false) {
  validateFixtureArguments(lines, includeSecrets);
  const header = [
    "line",
    "level",
    "component",
    "message",
    "note",
    "password",
    "authorization",
    "token"
  ];
  const rows = Array.from({ length: lines }, (_, index) => {
    const values = [
      String(index + 1),
      index % 5 === 0 ? "WARN" : "INFO",
      "fixture",
      "bounded, context evidence",
      index === 2 ? "two\nlines" : 'quote "proof"',
      includeSecrets && index === 4 ? FIXTURE_SECRETS[0] : "",
      includeSecrets && index === Math.floor(lines / 2)
        ? `Bearer ${FIXTURE_SECRETS[1]}`
        : "",
      includeSecrets && index === lines - 2 ? FIXTURE_SECRETS[2] : ""
    ];
    return `${values.map(csvCell).join(",")}\r\n`;
  });
  return `${header.join(",")}\r\n${rows.join("")}`;
}

export function buildFixtureMarkdown(lines, includeSecrets = false) {
  validateFixtureArguments(lines, includeSecrets);
  return [
    "# Fixture report\n",
    "Deterministic bounded-context evidence.\n\n",
    ...Array.from({ length: lines }, (_, index) => {
      let secret = "";
      if (includeSecrets && index === 4) {
        secret = `password=${FIXTURE_SECRETS[0]}\n`;
      } else if (includeSecrets && index === Math.floor(lines / 2)) {
        secret = `authorization=Bearer ${FIXTURE_SECRETS[1]}\n`;
      } else if (includeSecrets && index === lines - 2) {
        secret = `token=${FIXTURE_SECRETS[2]}\n`;
      }
      return (
        `## Event ${String(index + 1).padStart(6, "0")}\n` +
        `level=${index % 5 === 0 ? "WARN" : "INFO"} component=fixture\n` +
        'message="bounded context evidence" marker=✓\n' +
        secret +
        "\n"
      );
    })
  ].join("");
}

function serialize(value) {
  const serialized = JSON.stringify(value);
  if (typeof serialized !== "string") {
    throw new TypeError("value is not JSON serializable");
  }
  return serialized;
}

function serializedBytes(value) {
  return Buffer.byteLength(serialize(value), "utf8");
}

function contextViewResult(view, isError = false) {
  const result = {
    content: [{ type: "text", text: JSON.stringify(view) }],
    isError
  };
  if (serializedBytes(result) > MAX_TOOL_RESULT_BYTES) {
    throw new ResultTooLargeError(
      "Context View result exceeds the output limit"
    );
  }
  contextViewProvenance.set(result, {
    artifactId: view.artifact_id,
    viewId: view.view_id
  });
  return result;
}

function structuredToolResult(value) {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: false
  };
}

function safeToolFailure(code, message) {
  return {
    content: [{ type: "text", text: `${code}: ${message}` }],
    isError: true
  };
}

function retainedContextView(
  contextStore,
  text,
  mediaType,
  isError,
  retainedResult = false
) {
  try {
    return contextViewResult(
      contextStore.ingest(text, mediaType, { retainedResult }),
      isError
    );
  } catch (error) {
    if (error instanceof ContextRetentionError) {
      return safeToolFailure(
        "EG-CAS-001",
        "The result could not be retained within the configured artifact limit; no source content was emitted."
      );
    }
    if (error instanceof TypeError || error instanceof UnsafeArtifactError) {
      return safeToolFailure(
        "EG-VIEW-002",
        "The result could not be projected safely; no source content was emitted."
      );
    }
    if (error instanceof ResultTooLargeError || error instanceof RangeError) {
      return safeToolFailure(
        "EG-VIEW-001",
        "The retained result could not fit the configured view budget; no source content was emitted."
      );
    }
    throw error;
  }
}

export function boundToolResult(
  result,
  { contextStore, contextViewEligible }
) {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    !Array.isArray(result.content)
  ) {
    throw new TypeError("invalid tool result");
  }

  const serialized = serialize(result);
  const resultBytes = Buffer.byteLength(serialized, "utf8");
  const textItem = result.content[0];
  const validIsError =
    result.isError === undefined || typeof result.isError === "boolean";
  const unsupportedContent = result.content.some(
    (item) =>
      item === null ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      item.type !== "text" ||
      typeof item.text !== "string"
  );
  const exactTextResult =
    result.content.length === 1 &&
    validIsError &&
    Object.keys(result).every(
      (key) => key === "content" || key === "isError"
    ) &&
    textItem !== null &&
    typeof textItem === "object" &&
    !Array.isArray(textItem) &&
    textItem.type === "text" &&
    typeof textItem.text === "string" &&
    Object.keys(textItem).every((key) => key === "type" || key === "text");
  if (!validIsError) throw new TypeError("invalid tool result");
  let requiresView;
  try {
    requiresView =
      unsupportedContent ||
      (exactTextResult
        ? contextStore.requiresView(textItem.text)
        : contextStore.requiresView(serialized, "application/json"));
  } catch (error) {
    if (!(error instanceof UnsafeArtifactError)) throw error;
    return safeToolFailure(
      "EG-VIEW-002",
      "The result could not be projected safely; no source content was emitted."
    );
  }

  if (contextViewEligible && exactTextResult) {
    const textBytes = Buffer.byteLength(textItem.text, "utf8");
    if (
      textBytes > CONTEXT_PAGE_BYTES ||
      requiresView
    ) {
      return retainedContextView(
        contextStore,
        textItem.text,
        "text/plain",
        result.isError === true
      );
    }
  }

  if (
    contextViewEligible &&
    (resultBytes > MAX_TOOL_RESULT_BYTES ||
      requiresView)
  ) {
    return retainedContextView(
      contextStore,
      serialized,
      unsupportedContent
        ? "application/octet-stream"
        : "application/json",
      result.isError === true,
      true
    );
  }
  if (!contextViewEligible && requiresView) {
    return safeToolFailure(
      "EG-VIEW-002",
      "The typed result was withheld because it requires redaction or opaque-content handling; no source content was emitted."
    );
  }
  if (resultBytes > MAX_TOOL_RESULT_BYTES) {
    throw new ResultTooLargeError("tool result exceeds the output limit");
  }
  return result;
}

function errorMessage(id, code, message) {
  const safeId =
    (typeof id === "string" && Buffer.byteLength(id) <= MAX_ID_BYTES) ||
    (typeof id === "number" && Number.isSafeInteger(id))
      ? id
      : null;
  return { jsonrpc: "2.0", id: safeId, error: { code, message } };
}

function validateRequest(message) {
  const validId =
    message?.id === undefined ||
    (typeof message.id === "string" &&
      Buffer.byteLength(message.id) <= MAX_ID_BYTES) ||
    (typeof message.id === "number" && Number.isSafeInteger(message.id));
  return (
    message !== null &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    message.jsonrpc === "2.0" &&
    typeof message.method === "string" &&
    validId
  );
}

function fixtureResponse(request) {
  const id = request.id;

  switch (request.method) {
    case "initialize":
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "effectgate-fixture", version: EFFECTGATE_VERSION }
        }
      };

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      if (request.params?.cursor === "oversized") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: [
              {
                ...FIXTURE_TOOL,
                name: "oversized_catalog",
                description: "x".repeat(MAX_TOOL_RESULT_BYTES)
              }
            ]
          }
        };
      }
      if (request.params?.cursor === "page-2") {
        return {
          jsonrpc: "2.0",
          id,
          result: {
            tools: [FIXTURE_SECOND_TOOL, FIXTURE_LARGE_LOG_TOOL]
          }
        };
      }
      if (request.params?.cursor !== undefined) {
        return errorMessage(id, -32602, "The tools cursor is invalid.");
      }
      return {
        jsonrpc: "2.0",
        id,
        result: { tools: [FIXTURE_TOOL], nextCursor: "page-2" }
      };

    case "tools/call": {
      const { name, arguments: args } = request.params ?? {};
      if (name === FIXTURE_LARGE_LOG_TOOL.name) {
        if (
          args === null ||
          typeof args !== "object" ||
          Array.isArray(args) ||
          !Number.isSafeInteger(args.lines) ||
          args.lines < 1 ||
          args.lines > FIXTURE_MAX_LINES ||
          (args.format !== undefined &&
            args.format !== "log" &&
            args.format !== "jsonl" &&
            args.format !== "csv" &&
            args.format !== "markdown") ||
          (args.includeStructuredCopy !== undefined &&
            typeof args.includeStructuredCopy !== "boolean") ||
          (args.includeSecrets !== undefined &&
            typeof args.includeSecrets !== "boolean") ||
          Object.keys(args).some(
            (key) =>
              key !== "lines" &&
              key !== "format" &&
              key !== "includeStructuredCopy" &&
              key !== "includeSecrets"
          )
        ) {
          return errorMessage(id, -32602, "The tool arguments are invalid.");
        }
        const text =
          args.format === "jsonl"
            ? buildFixtureJsonl(args.lines, args.includeSecrets === true)
            : args.format === "csv"
              ? buildFixtureCsv(args.lines, args.includeSecrets === true)
              : args.format === "markdown"
                ? buildFixtureMarkdown(
                    args.lines,
                    args.includeSecrets === true
                  )
                : buildFixtureLog(args.lines, args.includeSecrets === true);
        return {
          jsonrpc: "2.0",
          id,
          result: {
            content: [{ type: "text", text }],
            ...(args.includeStructuredCopy
              ? { structuredContent: { text } }
              : {}),
            isError: false
          }
        };
      }

      if (
        (name !== FIXTURE_TOOL.name && name !== FIXTURE_SECOND_TOOL.name) ||
        args === null ||
        typeof args !== "object" ||
        Array.isArray(args) ||
        typeof args.text !== "string" ||
        [...args.text].length > 4096 ||
        Object.keys(args).some((key) => key !== "text")
      ) {
        return errorMessage(id, -32602, "The tool arguments are invalid.");
      }

      return {
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: args.text }],
          structuredContent: { text: args.text },
          isError: false
        }
      };
    }

    default:
      return errorMessage(id, -32601, "The requested method is unavailable.");
  }
}

export function runFixture() {
  let outputBlocked = false;
  const outputQueue = [];

  function flush() {
    if (outputBlocked) return;
    while (outputQueue.length > 0) {
      const next = outputQueue[0].next();
      if (next.done) {
        outputQueue.shift();
        continue;
      }
      if (writeMessage(process.stdout, next.value)) continue;
      outputBlocked = true;
      process.stdin.pause();
      process.stdout.once("drain", () => {
        outputBlocked = false;
        process.stdin.resume();
        flush();
      });
      return;
    }
  }

  function reply(message) {
    let messages;
    try {
      messages = boundedResponseMessages(
        message,
        CONTEXT_MAX_ARTIFACT_BYTES
      );
    } catch (error) {
      if (!(error instanceof FrameTooLargeError)) throw error;
      messages = [
        errorMessage(
          message?.id,
          -32005,
          "The response exceeds the configured transport limit."
        )
      ];
    }
    outputQueue.push(messages[Symbol.iterator]());
    flush();
  }

  readBoundedJsonLines(process.stdin, {
    onMessage(message) {
      if (!validateRequest(message)) {
        reply(
          errorMessage(
            message?.id,
            -32600,
            "The JSON-RPC request is invalid."
          )
        );
        return;
      }

      if (message.id === undefined) return;
      reply(fixtureResponse(message));
    },
    onError(kind) {
      const code = kind === "frame_too_large" ? -32001 : -32700;
      const message =
        kind === "frame_too_large"
          ? `The request exceeds the ${MAX_FRAME_BYTES}-byte frame limit.`
          : "The request is not valid UTF-8 JSON.";
      reply(errorMessage(null, code, message));
    }
  });
}

export function runConfiguredSkillMcp(runtime) {
  if (!runtime?.mcp || typeof runtime.mcp.dispatch !== "function" ||
      typeof runtime.close !== "function") {
    throw new TypeError("invalid configured Skill MCP runtime");
  }
  let queue = Promise.resolve();
  const reply = async (message) => {
    if (!writeMessage(process.stdout, message)) {
      await once(process.stdout, "drain");
    }
  };
  const enqueue = (task) => {
    queue = queue.then(task);
  };
  readBoundedJsonLines(process.stdin, {
    onMessage(message) {
      enqueue(async () => {
        let response;
        try {
          response = await runtime.mcp.dispatch(message);
        } catch {
          response = errorMessage(
            message?.id,
            -32603,
            "The configured Skill MCP operation failed."
          );
        }
        if (response !== null) await reply(response);
      });
    },
    onError(kind) {
      enqueue(() => reply(errorMessage(
        null,
        kind === "frame_too_large" ? -32001 : -32700,
        kind === "frame_too_large"
          ? `The request exceeds the ${MAX_FRAME_BYTES}-byte frame limit.`
          : "The request is not valid UTF-8 JSON."
      )));
    },
    onEnd() {
      queue.finally(() => runtime.close());
    }
  });
}

function parseServeArguments(args) {
  let source = "fixture";
  let sourceExplicit = false;
  let backendConfigFile;
  let maxSessionEmittedTokens = DEFAULT_MAX_SESSION_EMITTED_TOKENS;
  let tokenLedgerFile;
  let runId;
  let profile = "native_deferred";
  let hostEvidenceFile;

  for (let index = 0; index < args.length; index += 1) {
    const option = args[index];
    const value = args[index + 1];
    if (value === undefined) {
      throw new Error(SERVE_USAGE);
    }
    if (option === "--source") {
      if (sourceExplicit) throw new Error(SERVE_USAGE);
      source = value;
      sourceExplicit = true;
    } else if (
      option === "--config" &&
      backendConfigFile === undefined &&
      value.length > 0 &&
      Buffer.byteLength(value, "utf8") <= 1024 &&
      !value.includes("\0")
    ) {
      backendConfigFile = value;
    } else if (
      option === "--max-session-emitted-tokens" &&
      /^[1-9]\d{0,6}$/u.test(value) &&
      Number(value) <= MAX_SESSION_EMITTED_TOKENS
    ) {
      maxSessionEmittedTokens = Number(value);
    } else if (
      option === "--token-ledger" &&
      value.length > 0 &&
      Buffer.byteLength(value, "utf8") <= 1024 &&
      !value.includes("\0")
    ) {
      tokenLedgerFile = value;
    } else if (
      option === "--run-id" &&
      /^[A-Za-z0-9_-]{1,128}$/u.test(value)
    ) {
      runId = value;
    } else if (
      option === "--profile" &&
      TOKEN_LEDGER_PROFILES.has(value)
    ) {
      profile = value;
    } else if (
      option === "--host-evidence" &&
      value.length > 0 &&
      Buffer.byteLength(value, "utf8") <= 1024 &&
      !value.includes("\0")
    ) {
      hostEvidenceFile = value;
    } else {
      throw new Error(SERVE_USAGE);
    }
    index += 1;
  }

  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(source)) {
    throw new Error("Backend source must match [A-Za-z0-9_.-] and be <=64 chars.");
  }
  if (sourceExplicit && backendConfigFile !== undefined) {
    throw new Error(SERVE_USAGE);
  }

  return {
    source,
    backendConfigFile,
    maxSessionEmittedTokens,
    tokenLedgerFile,
    runId,
    profile,
    hostEvidenceFile
  };
}

export function runProxy(args) {
  const {
    source: requestedSource,
    backendConfigFile,
    maxSessionEmittedTokens,
    tokenLedgerFile,
    runId,
    profile,
    hostEvidenceFile
  } = parseServeArguments(args);
  const reviewedBackend = backendConfigFile === undefined
    ? undefined
    : loadReviewedBackendConfig(backendConfigFile).config;
  const source = reviewedBackend?.source ?? requestedSource;
  const secretEnvironment = resolveEnvironmentSecretRefs(
    reviewedBackend?.secret_refs
  );
  const compactMux = profile === "compact_mux";
  const hostEvidence = hostEvidenceFile === undefined
    ? undefined
    : loadHostCompatibilityEvidence(hostEvidenceFile);
  const prefix = `${source}__`;
  const pending = new Map();
  let toolNames = new Map();
  let catalogComplete = false;
  let deferralDecision = decideNativeDeferral(undefined);
  const contextStore = new ContextStore();
  const sessionOutput = createSessionOutputGuard({
    maxTokens: maxSessionEmittedTokens
  });
  const tokenLedger = tokenLedgerFile === undefined
    ? null
    : new TokenLedger({
        file: tokenLedgerFile,
        runId: runId ?? contextStore.sessionId,
        sessionId: contextStore.sessionId,
        profile
      });
  const child = spawn(
    reviewedBackend?.executable_path ?? process.execPath,
    reviewedBackend?.argv ??
      [fileURLToPath(import.meta.url), "fixture"],
    {
      ...(reviewedBackend === undefined
        ? {}
        : { cwd: reviewedBackend.working_directory }),
      env: backendEnvironment(secretEnvironment),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    }
  );
  let lifecycle = "new";
  let sequence = 0;
  let backendAvailable = true;
  let reportedStderr = false;
  let backendInputBlocked = false;
  let outputBlocked = false;

  function guardModelVisible(result, provenance) {
    const view = contextViewProvenance.get(result);
    sessionOutput.admit(serialize(result), ({ bytes, token_count }) => {
      tokenLedger?.append({
        ...provenance,
        ...(view === undefined
          ? {}
          : {
              ...view,
              category: "context_view_tokens_emitted"
            }),
        direction: "to_host",
        tokenCount: token_count,
        bytes
      });
    });
    return result;
  }

  function reply(message) {
    let writable;
    try {
      writable = writeMessage(process.stdout, message);
    } catch (error) {
      if (!(error instanceof FrameTooLargeError)) throw error;
      writable = writeMessage(
        process.stdout,
        errorMessage(
          message?.id,
          -32005,
          "The response exceeds the configured frame limit."
        )
      );
    }

    if (writable || outputBlocked) return;
    outputBlocked = true;
    process.stdin.pause();
    child.stdout.pause();
    process.stdout.once("drain", () => {
      outputBlocked = false;
      if (!backendInputBlocked) process.stdin.resume();
      if (backendAvailable) child.stdout.resume();
    });
  }

  function failBackend(code, message) {
    if (!backendAvailable) return;
    backendAvailable = false;
    for (const { clientId, timeout } of pending.values()) {
      clearTimeout(timeout);
      reply(errorMessage(clientId, code, message));
    }
    pending.clear();
  }

  function sendBackend(message) {
    if (!backendAvailable) return false;
    if (child.stdin.destroyed) {
      failBackend(-32002, "The backend is unavailable.");
      return false;
    }
    try {
      const writable = writeMessage(child.stdin, message);
      if (!writable && !backendInputBlocked) {
        backendInputBlocked = true;
        process.stdin.pause();
        child.stdin.once("drain", () => {
          backendInputBlocked = false;
          if (!outputBlocked) process.stdin.resume();
        });
      }
      return true;
    } catch (error) {
      if (error instanceof FrameTooLargeError) return false;
      failBackend(-32002, "The backend is unavailable.");
      return false;
    }
  }

  function publicToolName(backendName) {
    const candidate = `${prefix}${backendName}`;
    if (candidate.length <= 128) return candidate;
    const digest = createHash("sha256").update(candidate).digest("hex").slice(0, 16);
    return `${source}__${digest}`;
  }

  function forward(
    clientRequest,
    method,
    params,
    transform = (value) => value,
    onResult
  ) {
    if (!backendAvailable) {
      reply(errorMessage(clientRequest.id, -32002, "The backend is unavailable."));
      return;
    }

    if (pending.size >= MAX_PENDING_REQUESTS) {
      reply(
        errorMessage(
          clientRequest.id,
          -32006,
          "The proxy request limit is currently full."
        )
      );
      return;
    }

    const backendId = `eg-${++sequence}`;
    const timeout = setTimeout(() => {
      pending.delete(backendId);
      reply(errorMessage(clientRequest.id, -32003, "The backend request timed out."));
    }, 10_000);
    timeout.unref();
    pending.set(backendId, {
      clientId: clientRequest.id,
      timeout,
      transform,
      method,
      ...(onResult === undefined ? {} : { onResult }),
      ...(method === "tools/call"
        ? {
            chunkedResult: new ChunkedResultReceiver(
              backendId,
              CONTEXT_MAX_ARTIFACT_BYTES
            )
          }
        : {})
    });
    if (!sendBackend({
      jsonrpc: "2.0",
      id: backendId,
      method,
      params: params ?? {}
    })) {
      clearTimeout(timeout);
      if (pending.delete(backendId)) {
        reply(
          errorMessage(
            clientRequest.id,
            -32001,
            "The request exceeds the backend frame limit."
          )
        );
      }
    }
  }

  readBoundedJsonLines(child.stdout, {
    onMessage(message) {
      if (
        message?.jsonrpc === "2.0" &&
        message.id === undefined &&
        typeof message.method === "string"
      ) {
        if (message.method === CHUNKED_RESULT_METHOD) {
          const waiting = pending.get(message.params?.request_id);
          if (!waiting?.chunkedResult) return;
          try {
            waiting.chunkedResult.accept(message);
          } catch {
            failBackend(-32004, "The backend response is invalid.");
            child.kill();
          }
          return;
        }
        if (message.method === "notifications/tools/list_changed") {
          if (reviewedBackend) {
            failBackend(
              -32004,
              "The reviewed backend changed after admission."
            );
            child.kill();
          } else {
            toolNames = new Map();
            catalogComplete = false;
            reply(message);
          }
        }
        return;
      }

      if (!validateResponse(message)) {
        failBackend(-32004, "The backend response is invalid.");
        child.kill();
        return;
      }

      const waiting = pending.get(message?.id);
      if (!waiting) return;
      clearTimeout(waiting.timeout);
      pending.delete(message.id);

      if (message.error) {
        if (waiting.chunkedResult?.started) {
          failBackend(-32004, "The backend response is invalid.");
          child.kill();
          reply(
            errorMessage(
              waiting.clientId,
              -32004,
              "The backend response is invalid."
            )
          );
          return;
        }
        reply(
          errorMessage(
            waiting.clientId,
            -32000,
            "The backend rejected the request."
          )
        );
        return;
      }

      try {
        const result = waiting.chunkedResult === undefined
          ? message.result
          : waiting.chunkedResult.finish(message.result);
        if (tokenLedger && waiting.method === "tools/call") {
          const raw = serialize(result);
          tokenLedger.append({
            stage: "backend_raw_result",
            direction: "from_host",
            tokenCount: BYTE_PROXY_COUNTER.measure({ content: raw }),
            bytes: Buffer.byteLength(raw, "utf8")
          });
        }
        if (waiting.onResult !== undefined) {
          waiting.onResult(result);
          return;
        }
        reply({
          jsonrpc: "2.0",
          id: waiting.clientId,
          result: waiting.transform(result)
        });
      } catch (error) {
        if (error instanceof ReviewedBackendDriftError) {
          failBackend(
            -32004,
            "The reviewed backend changed after admission."
          );
          child.kill();
          reply(
            errorMessage(
              waiting.clientId,
              -32004,
              "The reviewed backend changed after admission."
            )
          );
          return;
        }
        const accounting = accountingFailure(error);
        if (accounting) {
          reply(
            errorMessage(
              waiting.clientId,
              accounting.code,
              accounting.message
            )
          );
          return;
        }
        if (error instanceof ResultTooLargeError) {
          reply(
            errorMessage(
              waiting.clientId,
              -32005,
              `The response exceeds the ${MAX_TOOL_RESULT_BYTES}-byte result limit.`
            )
          );
          return;
        }
        reply(
          errorMessage(
            waiting.clientId,
            -32004,
            "The backend returned an invalid response."
          )
        );
      }
    },
    onError() {
      failBackend(-32004, "The backend response is invalid.");
      child.kill();
    },
    onEnd() {
      failBackend(-32002, "The backend is unavailable.");
      child.kill();
    }
  });

  child.stderr.on("data", () => {
    if (reportedStderr) return;
    reportedStderr = true;
    process.stderr.write("[effectgate] backend stderr suppressed\n");
  });

  child.on("error", () => {
    failBackend(-32002, "The backend is unavailable.");
  });

  child.on("exit", () => {
    failBackend(-32002, "The backend is unavailable.");
  });

  child.stdin.on("error", () => {
    failBackend(-32002, "The backend is unavailable.");
  });

  process.once("exit", () => child.kill());

  function verifyCatalog(result) {
    if (reviewedBackend === undefined) return;
    try {
      verifyReviewedBackendFiles(reviewedBackend);
    } catch {
      throw new ReviewedBackendDriftError();
    }
    if (canonicalJson(result) !== canonicalJson(reviewedBackend.catalog)) {
      throw new ReviewedBackendDriftError();
    }
  }

  function admitCatalog(result, currentNames = new Map()) {
    if (!Array.isArray(result?.tools) ||
        (result.nextCursor !== undefined &&
          typeof result.nextCursor !== "string")) {
      throw new Error("invalid tools");
    }
    const nextNames = new Map(currentNames);
    const tools = result.tools.flatMap((tool) => {
      if (!isValidToolContract(tool)) throw new Error("invalid tool contract");
      if (!isSafeReadTool(tool)) return [];
      const publicName = publicToolName(tool.name);
      if (nextNames.has(publicName)) throw new Error("tool name collision");
      const publicContract = withNativeDeferralMetadata(
        { ...tool, name: publicName },
        deferralDecision
      );
      if (serializedBytes(publicContract) > MAX_TOOL_RESULT_BYTES) {
        throw new ResultTooLargeError("tool contract exceeds the output limit");
      }
      nextNames.set(publicName, {
        backendName: tool.name,
        contextViewEligible: tool.outputSchema === undefined,
        contract: publicContract
      });
      return [publicContract];
    });
    return { nextNames, tools };
  }

  function loadCompactCatalog(clientRequest) {
    const cursors = new Set();
    const loadPage = (params, names) => forward(
      clientRequest,
      "tools/list",
      params,
      undefined,
      (result) => {
        verifyCatalog(result);
        const { nextNames } = admitCatalog(result, names);
        if (result.nextCursor !== undefined) {
          if (cursors.size >= MAX_PENDING_REQUESTS ||
              cursors.has(result.nextCursor)) {
            throw new Error("invalid tools cursor");
          }
          cursors.add(result.nextCursor);
          loadPage({ cursor: result.nextCursor }, nextNames);
          return;
        }
        const publicCatalog = {
          tools: [...COMPACT_MUX_TOOLS, CONTEXT_FETCH_TOOL]
        };
        const guardedCatalog = guardModelVisible(publicCatalog, {
          stage: "tool_metadata",
          category: "tool_schema_tokens_emitted"
        });
        toolNames = nextNames;
        catalogComplete = true;
        reply({
          jsonrpc: "2.0",
          id: clientRequest.id,
          result: guardedCatalog
        });
      }
    );
    loadPage({}, new Map());
  }

  readBoundedJsonLines(process.stdin, {
    onMessage(message) {
      if (!validateRequest(message)) {
        reply(
          errorMessage(
            message?.id,
            -32600,
            "The JSON-RPC request is invalid."
          )
        );
        return;
      }

      if (message.id === undefined) {
        if (message.method === "notifications/initialized") {
          if (lifecycle === "awaiting_initialized") {
            lifecycle = "ready";
            sendBackend(message);
          }
        } else if (message.method === "notifications/cancelled") {
          const clientId = message.params?.requestId;
          const match = [...pending.entries()].find(
            ([, value]) => value.clientId === clientId
          );
          if (match) {
            sendBackend({
              ...message,
              params: { ...message.params, requestId: match[0] }
            });
          }
        }
        return;
      }

      if (
        message.method !== "initialize" &&
        lifecycle !== "ready"
      ) {
        reply(
          errorMessage(
            message.id,
            -32007,
            "The MCP session is not initialized."
          )
        );
        return;
      }

      switch (message.method) {
        case "initialize": {
          if (lifecycle !== "new") {
            reply(
              errorMessage(
                message.id,
                -32600,
                "This MCP session is already initialized."
              )
            );
            break;
          }
          if (message.params?.protocolVersion !== MCP_VERSION) {
            reply(
              errorMessage(
                message.id,
                -32602,
                `This EffectGate build supports MCP ${MCP_VERSION} only.`
              )
            );
            break;
          }
          const evaluatedDeferral = decideNativeDeferral(hostEvidence, {
            clientInfo: message.params?.clientInfo,
            clientBuildDigest:
              message.params?._meta?.["dev.effectgate/clientBuildDigest"]
          });
          deferralDecision = profile === "native_deferred"
            ? evaluatedDeferral
            : Object.freeze({
                eligible: false,
                reason: "profile_not_native_deferred"
              });
          lifecycle = "initializing";
          toolNames = new Map();
          forward(message, "initialize", {
            protocolVersion: MCP_VERSION,
            capabilities: {},
            clientInfo: {
              name: "effectgate-preview",
              version: EFFECTGATE_VERSION
            }
          }, (result) => {
            if (
              result === null ||
              typeof result !== "object" ||
              Array.isArray(result) ||
              result.protocolVersion !== MCP_VERSION
            ) {
              throw new Error("unsupported backend protocol");
            }
            if (reviewedBackend !== undefined &&
                (canonicalJson(result.serverInfo) !== canonicalJson(
                  reviewedBackend.server_identity
                ) ||
                  result.capabilities?.tools?.listChanged === true)) {
              throw new ReviewedBackendDriftError();
            }
            lifecycle = "awaiting_initialized";
            return {
              protocolVersion: MCP_VERSION,
              capabilities: {
                tools: {
                  listChanged: reviewedBackend === undefined &&
                    result.capabilities?.tools?.listChanged === true
                }
              },
              serverInfo: {
                name: "effectgate-preview",
                version: EFFECTGATE_VERSION
              },
              _meta: {
                "dev.effectgate/nativeDeferral": deferralDecision
              }
            };
          });
          break;
        }

        case "ping":
          forward(message, "ping", message.params);
          break;

        case "tools/list":
          if (reviewedBackend !== undefined &&
              message.params !== undefined &&
              (message.params === null ||
                typeof message.params !== "object" ||
                Array.isArray(message.params) ||
                Object.keys(message.params).length !== 0)) {
            reply(
              errorMessage(
                message.id,
                -32602,
                "Reviewed backend catalogs do not accept pagination."
              )
            );
            break;
          }
          if (compactMux) {
            if (message.params?.cursor !== undefined) {
              reply(errorMessage(
                message.id,
                -32602,
                "The tools cursor is invalid."
              ));
              break;
            }
            toolNames = new Map();
            catalogComplete = false;
            loadCompactCatalog(message);
            break;
          }
          if (message.params?.cursor === undefined) {
            toolNames = new Map();
            catalogComplete = false;
          }
          forward(message, "tools/list", message.params, (result) => {
            verifyCatalog(result);
            const currentNames =
              typeof message.params?.cursor === "string"
                ? new Map(toolNames)
                : new Map();
            const { nextNames, tools } = admitCatalog(result, currentNames);
            const publicCatalog = {
              ...result,
              tools: message.params?.cursor === undefined
                ? [
                    ...tools,
                    CONTEXT_FETCH_TOOL,
                    CONTEXT_SEARCH_TOOL,
                    CONTEXT_PROJECT_TOOL
                  ]
                : tools
            };
            if (serializedBytes(publicCatalog) > MAX_TOOL_RESULT_BYTES) {
              throw new ResultTooLargeError(
                "tool catalog exceeds the output limit"
              );
            }
            const guardedCatalog = guardModelVisible(publicCatalog, {
              stage: "tool_metadata",
              category: "tool_schema_tokens_emitted"
            });
            toolNames = nextNames;
            catalogComplete = result.nextCursor === undefined;
            return guardedCatalog;
          });
          break;

        case "tools/call": {
          const publicName = message.params?.name;
          if (publicName === CONTEXT_FETCH_TOOL.name) {
            const callArguments = message.params?.arguments;
            if (
              callArguments === null ||
              typeof callArguments !== "object" ||
              Array.isArray(callArguments) ||
              typeof callArguments.cursor !== "string" ||
              Buffer.byteLength(callArguments.cursor, "utf8") >
                CURSOR_MAX_BYTES ||
              !CURSOR_INPUT_PATTERN.test(callArguments.cursor) ||
              Object.keys(callArguments).some((key) => key !== "cursor")
            ) {
              reply(
                errorMessage(
                  message.id,
                  -32602,
                  "The retrieval cursor is invalid."
                )
              );
              return;
            }
            try {
              reply({
                jsonrpc: "2.0",
                id: message.id,
                result: guardModelVisible(
                  contextViewResult(
                    contextStore.fetch(callArguments.cursor)
                  ),
                  {
                    stage: "fetch_page",
                    category: "context_view_tokens_emitted"
                  }
                )
              });
            } catch (error) {
              const accounting = accountingFailure(error);
              reply(
                errorMessage(
                  message.id,
                  error instanceof InvalidCursorError
                    ? -32602
                    : accounting?.code ?? -32603,
                  error instanceof InvalidCursorError
                    ? "The retrieval cursor is invalid."
                    : accounting?.message ??
                      "The Context View could not be created."
                )
              );
            }
            return;
          }

          if (compactMux && publicName === COMPACT_SEARCH_TOOL.name) {
            try {
              reply({
                jsonrpc: "2.0",
                id: message.id,
                result: guardModelVisible(
                  structuredToolResult(
                    searchCompactCapabilities(
                      toolNames,
                      message.params?.arguments,
                      catalogComplete
                    )
                  ),
                  {
                    stage: "tool_metadata",
                    category: "tool_schema_tokens_emitted"
                  }
                )
              });
            } catch {
              reply(
                errorMessage(
                  message.id,
                  -32602,
                  "The compact search arguments are invalid."
                )
              );
            }
            return;
          }

          if (compactMux && publicName === COMPACT_DESCRIBE_TOOL.name) {
            try {
              const described = describeCompactCapability(
                toolNames,
                message.params?.arguments
              );
              if (serializedBytes(described) > MAX_TOOL_RESULT_BYTES) {
                throw new ResultTooLargeError(
                  "compact description exceeds the output limit"
                );
              }
              reply({
                jsonrpc: "2.0",
                id: message.id,
                result: guardModelVisible(
                  structuredToolResult(described),
                  {
                    stage: "tool_metadata",
                    category: "tool_schema_tokens_emitted"
                  }
                )
              });
            } catch (error) {
              reply(
                errorMessage(
                  message.id,
                  error instanceof ResultTooLargeError ? -32005 : -32602,
                  error instanceof ResultTooLargeError
                    ? `The response exceeds the ${MAX_TOOL_RESULT_BYTES}-byte result limit.`
                    : "The compact capability reference is invalid."
                )
              );
            }
            return;
          }

          if (compactMux && publicName === COMPACT_CALL_TOOL.name) {
            try {
              const call = compactCallArguments(
                toolNames,
                message.params?.arguments
              );
              forward(message, "tools/call", {
                name: call.backendName,
                arguments: call.arguments
              }, (result) =>
                guardModelVisible(
                  boundToolResult(result, {
                    contextStore,
                    contextViewEligible: call.contextViewEligible
                  }),
                  {
                    stage: "first_view",
                    category: "tool_result_tokens_emitted"
                  }
                )
              );
            } catch {
              reply(
                errorMessage(
                  message.id,
                  -32602,
                  "The compact call arguments are invalid."
                )
              );
            }
            return;
          }

          if (!compactMux && publicName === CONTEXT_SEARCH_TOOL.name) {
            const callArguments = message.params?.arguments;
            const queryLength =
              typeof callArguments?.query === "string"
                ? callArguments.query.length >
                    CONTEXT_SEARCH_MAX_QUERY_LENGTH * 2
                  ? CONTEXT_SEARCH_MAX_QUERY_LENGTH + 1
                  : [...callArguments.query].length
                : 0;
            if (
              callArguments === null ||
              typeof callArguments !== "object" ||
              Array.isArray(callArguments) ||
              typeof callArguments.artifact_id !== "string" ||
              !/^art_[a-f0-9]{64}$/.test(callArguments.artifact_id) ||
              queryLength < 1 ||
              queryLength > CONTEXT_SEARCH_MAX_QUERY_LENGTH ||
              Buffer.byteLength(callArguments.query ?? "", "utf8") >
                CONTEXT_SEARCH_MAX_QUERY_LENGTH * 4 ||
              (callArguments.context_lines !== undefined &&
                (!Number.isSafeInteger(callArguments.context_lines) ||
                  callArguments.context_lines < 0 ||
                  callArguments.context_lines >
                    CONTEXT_SEARCH_MAX_CONTEXT_LINES)) ||
              (callArguments.max_tokens !== undefined &&
                (!Number.isSafeInteger(callArguments.max_tokens) ||
                  callArguments.max_tokens < CONTEXT_SEARCH_MIN_TOKENS ||
                  callArguments.max_tokens > CONTEXT_SEARCH_MAX_TOKENS)) ||
              Object.keys(callArguments).some(
                (key) =>
                  key !== "artifact_id" &&
                  key !== "query" &&
                  key !== "context_lines" &&
                  key !== "max_tokens"
              )
            ) {
              reply(
                errorMessage(
                  message.id,
                  -32602,
                  "The search arguments are invalid."
                )
              );
              return;
            }
            try {
              reply({
                jsonrpc: "2.0",
                id: message.id,
                result: guardModelVisible(
                  contextViewResult(
                    contextStore.search(
                      callArguments.artifact_id,
                      callArguments.query,
                      callArguments.context_lines ?? 1,
                      callArguments.max_tokens ?? 512
                    )
                  ),
                  {
                    stage: "first_view",
                    category: "context_view_tokens_emitted"
                  }
                )
              });
            } catch (error) {
              const accounting = accountingFailure(error);
              reply(
                errorMessage(
                  message.id,
                  error instanceof InvalidArtifactError ||
                    error instanceof TypeError
                    ? -32602
                    : accounting?.code ?? -32603,
                  error instanceof InvalidArtifactError
                    ? "The artifact reference is invalid."
                    : error instanceof TypeError
                      ? "The search arguments are invalid."
                      : accounting?.message ??
                        "The Context View could not be created."
                )
              );
            }
            return;
          }

          if (!compactMux && publicName === CONTEXT_PROJECT_TOOL.name) {
            const callArguments = message.params?.arguments;
            const fields = callArguments?.fields ?? [];
            const columns = callArguments?.columns ?? [];
            const filter = callArguments?.filter;
            if (
              callArguments === null ||
              typeof callArguments !== "object" ||
              Array.isArray(callArguments) ||
              typeof callArguments.artifact_id !== "string" ||
              !/^art_[a-f0-9]{64}$/.test(callArguments.artifact_id) ||
              !isValidProjectionOptions({
                format: callArguments.format,
                fields,
                columns,
                filter,
                heading: callArguments.heading
              }) ||
              (callArguments.offset !== undefined &&
                (!Number.isSafeInteger(callArguments.offset) ||
                  callArguments.offset < 0 ||
                  callArguments.offset > CONTEXT_PROJECT_MAX_OFFSET)) ||
              (callArguments.limit !== undefined &&
                (!Number.isSafeInteger(callArguments.limit) ||
                  callArguments.limit < 1 ||
                  callArguments.limit > CONTEXT_PROJECT_MAX_LIMIT)) ||
              (callArguments.max_tokens !== undefined &&
                (!Number.isSafeInteger(callArguments.max_tokens) ||
                  callArguments.max_tokens < CONTEXT_PROJECT_MIN_TOKENS ||
                  callArguments.max_tokens > CONTEXT_PROJECT_MAX_TOKENS)) ||
              Object.keys(callArguments).some(
                (key) =>
                  key !== "artifact_id" &&
                  key !== "format" &&
                  key !== "fields" &&
                  key !== "columns" &&
                  key !== "filter" &&
                  key !== "heading" &&
                  key !== "offset" &&
                  key !== "limit" &&
                  key !== "max_tokens"
              )
            ) {
              reply(
                errorMessage(
                  message.id,
                  -32602,
                  "The projection arguments are invalid."
                )
              );
              return;
            }
            try {
              reply({
                jsonrpc: "2.0",
                id: message.id,
                result: guardModelVisible(
                  contextViewResult(
                    contextStore.project(callArguments.artifact_id, {
                      format: callArguments.format,
                      fields,
                      columns,
                      ...(filter ? { filter } : {}),
                      ...(callArguments.heading !== undefined
                        ? { heading: callArguments.heading }
                        : {}),
                      offset: callArguments.offset ?? 0,
                      limit: callArguments.limit ?? 100,
                      maxTokens: callArguments.max_tokens ?? 512
                    })
                  ),
                  {
                    stage: "first_view",
                    category: "context_view_tokens_emitted"
                  }
                )
              });
            } catch (error) {
              const accounting = accountingFailure(error);
              reply(
                errorMessage(
                  message.id,
                  error instanceof InvalidArtifactError ||
                    error instanceof TypeError
                    ? -32602
                    : accounting?.code ?? -32603,
                  error instanceof InvalidArtifactError
                    ? "The artifact reference is invalid."
                    : error instanceof TypeError
                      ? "The projection arguments are invalid."
                      : accounting?.message ??
                        "The Context View could not be created."
                )
              );
            }
            return;
          }

          if (compactMux) {
            reply(
              errorMessage(
                message.id,
                -32602,
                "The compact tool name is invalid."
              )
            );
            return;
          }

          const admittedTool = toolNames.get(publicName);
          if (
            typeof publicName !== "string" ||
            typeof admittedTool?.backendName !== "string"
          ) {
            reply(
              errorMessage(
                message.id,
                -32602,
                "The proxied tool name is invalid."
              )
            );
            return;
          }
          if (reviewedBackend !== undefined) {
            try {
              verifyReviewedBackendFiles(reviewedBackend, false);
            } catch {
              failBackend(
                -32004,
                "The reviewed backend changed after admission."
              );
              child.kill();
              reply(
                errorMessage(
                  message.id,
                  -32004,
                  "The reviewed backend changed after admission."
                )
              );
              return;
            }
          }
          forward(message, "tools/call", {
            ...message.params,
            name: admittedTool.backendName
          }, (result) =>
            guardModelVisible(
              boundToolResult(result, {
                contextStore,
                contextViewEligible: admittedTool.contextViewEligible
              }),
              {
                stage: "first_view",
                category: "tool_result_tokens_emitted"
              }
            )
          );
          break;
        }

        default:
          reply(
            errorMessage(
              message.id,
              -32601,
              "The requested method is unavailable."
            )
          );
      }
    },
    onError(kind) {
      const code = kind === "frame_too_large" ? -32001 : -32700;
      const message =
        kind === "frame_too_large"
          ? `The request exceeds the ${MAX_FRAME_BYTES}-byte frame limit.`
          : "The request is not valid UTF-8 JSON.";
      reply(errorMessage(null, code, message));
    },
    onEnd() {
      tokenLedger?.close();
      contextStore.close();
      child.kill();
    }
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args.length === 1 && ["--version", "-v"].includes(args[0])) {
    process.stdout.write(`${EFFECTGATE_VERSION}\n`);
    return;
  }

  if ([
    "init", "doctor", "status", "receipt", "approve", "resolve",
    "uninstall", "purge", "backup", "restore", "rollback"
  ].includes(args[0])) {
    const { runOperatorCli } = await import(
      "../operator/operator-cli.mjs"
    );
    process.exitCode = await runOperatorCli(args);
    return;
  }

  if (args[0] === "fixture" && args.length === 1) {
    runFixture();
    return;
  }

  if (args[0] === "mcp" && args[1] === "serve") {
    runProxy(args.slice(2));
    return;
  }

  if (args.length === 5 && args[0] === "mcp" &&
      args[1] === "skill" && args[2] === "serve" &&
      args[3] === "--config") {
    const { createConfiguredSkillMcp } = await import(
      "../skill/skill-runtime-config.mjs"
    );
    runConfiguredSkillMcp(await createConfiguredSkillMcp(args[4]));
    return;
  }

  throw new Error(SERVE_USAGE);
}

const isMain = process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`[effectgate] ${error.message}\n`);
    process.exitCode = 2;
  });
}
