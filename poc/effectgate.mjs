#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import process from "node:process";

export const MAX_FRAME_BYTES = 1024 * 1024;
export const MCP_VERSION = "2025-11-25";
const MAX_PENDING_REQUESTS = 64;
const MAX_ID_BYTES = 128;

class FrameTooLargeError extends Error {}

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

function writeMessage(stream, message) {
  const frame = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError();
  }
  return stream.write(frame);
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

function validateResponse(message) {
  const hasResult = Object.hasOwn(message ?? {}, "result");
  const hasError = Object.hasOwn(message ?? {}, "error");
  return (
    message !== null &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    message.jsonrpc === "2.0" &&
    ((typeof message.id === "string" &&
      Buffer.byteLength(message.id) <= MAX_ID_BYTES) ||
      (typeof message.id === "number" && Number.isSafeInteger(message.id))) &&
    hasResult !== hasError &&
    (!hasError ||
      (message.error !== null &&
        typeof message.error === "object" &&
        !Array.isArray(message.error)))
  );
}

export function isPhase0SafeTool(tool) {
  return (
    tool?.annotations?.readOnlyHint === true &&
    tool.annotations.destructiveHint === false &&
    tool.annotations.idempotentHint === true &&
    tool.annotations.openWorldHint === false
  );
}

export function readBoundedJsonLines(stream, { onMessage, onError, onEnd }) {
  let buffered = Buffer.alloc(0);
  let discarding = false;

  stream.on("data", (incoming) => {
    let chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);

    while (chunk.length > 0) {
      const newline = chunk.indexOf(0x0a);
      const segment = newline === -1 ? chunk : chunk.subarray(0, newline);
      chunk = newline === -1 ? Buffer.alloc(0) : chunk.subarray(newline + 1);

      if (discarding) {
        if (newline !== -1) discarding = false;
        continue;
      }

      if (buffered.length + segment.length > MAX_FRAME_BYTES) {
        buffered = Buffer.alloc(0);
        discarding = newline === -1;
        onError("frame_too_large");
        continue;
      }

      buffered = Buffer.concat([buffered, segment]);
      if (newline === -1) continue;

      const line =
        buffered.at(-1) === 0x0d
          ? buffered.subarray(0, buffered.length - 1)
          : buffered;
      buffered = Buffer.alloc(0);
      if (line.length === 0) continue;

      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
        onMessage(JSON.parse(text));
      } catch {
        onError("invalid_json");
      }
    }
  });

  stream.on("end", () => {
    if (buffered.length > 0 && !discarding) onError("invalid_json");
    onEnd?.();
  });
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
          serverInfo: { name: "effectgate-fixture", version: "0.0.0" }
        }
      };

    case "ping":
      return { jsonrpc: "2.0", id, result: {} };

    case "tools/list":
      if (request.params?.cursor === "page-2") {
        return {
          jsonrpc: "2.0",
          id,
          result: { tools: [FIXTURE_SECOND_TOOL] }
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

  function reply(message) {
    const writable = writeMessage(process.stdout, message);
    if (writable || outputBlocked) return;
    outputBlocked = true;
    process.stdin.pause();
    process.stdout.once("drain", () => {
      outputBlocked = false;
      process.stdin.resume();
    });
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

function parseServeArguments(args) {
  let source = "fixture";

  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== "--source" || index + 1 >= args.length) {
      throw new Error(
        "Usage: effectgate.mjs mcp serve [--source NAME]"
      );
    }
    source = args[index + 1];
    index += 1;
  }

  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(source)) {
    throw new Error("Backend source must match [A-Za-z0-9_.-] and be <=64 chars.");
  }

  return { source };
}

function backendEnvironment() {
  const allowed = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP"
  ];
  return Object.fromEntries(
    allowed
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]])
  );
}

export function runProxy(args) {
  const { source } = parseServeArguments(args);
  const prefix = `${source}__`;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "fixture"], {
    env: backendEnvironment(),
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true
  });
  const pending = new Map();
  let toolNames = new Map();
  let sequence = 0;
  let backendAvailable = true;
  let reportedStderr = false;
  let backendInputBlocked = false;
  let outputBlocked = false;

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

  function forward(clientRequest, method, params, transform = (value) => value) {
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
    pending.set(backendId, { clientId: clientRequest.id, timeout, transform });
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
        if (message.method === "notifications/tools/list_changed") {
          toolNames = new Map();
          reply(message);
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
        reply({
          jsonrpc: "2.0",
          id: waiting.clientId,
          result: waiting.transform(message.result)
        });
      } catch {
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
          sendBackend(message);
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

      switch (message.method) {
        case "initialize":
          if (message.params?.protocolVersion !== MCP_VERSION) {
            reply(
              errorMessage(
                message.id,
                -32602,
                `Phase 0 supports MCP ${MCP_VERSION} only.`
              )
            );
            break;
          }
          toolNames = new Map();
          forward(message, "initialize", {
            protocolVersion: MCP_VERSION,
            capabilities: {},
            clientInfo: { name: "effectgate-phase0", version: "0.0.0" }
          }, (result) => {
            if (
              result === null ||
              typeof result !== "object" ||
              Array.isArray(result) ||
              result.protocolVersion !== MCP_VERSION
            ) {
              throw new Error("unsupported backend protocol");
            }
            return {
              protocolVersion: MCP_VERSION,
              capabilities: {
                tools: {
                  listChanged: result.capabilities?.tools?.listChanged === true
                }
              },
              serverInfo: { name: "effectgate-phase0", version: "0.0.0" }
            };
          });
          break;

        case "ping":
          forward(message, "ping", message.params);
          break;

        case "tools/list":
          forward(message, "tools/list", message.params, (result) => {
            if (!Array.isArray(result?.tools)) throw new Error("invalid tools");
            const nextNames =
              typeof message.params?.cursor === "string"
                ? new Map(toolNames)
                : new Map();
            const tools = result.tools.flatMap((tool) => {
              if (
                tool === null ||
                typeof tool !== "object" ||
                Array.isArray(tool) ||
                typeof tool.name !== "string" ||
                !/^[A-Za-z0-9_.-]{1,128}$/.test(tool.name) ||
                tool.inputSchema === null ||
                typeof tool.inputSchema !== "object" ||
                Array.isArray(tool.inputSchema)
              ) {
                throw new Error("invalid tool contract");
              }
              if (!isPhase0SafeTool(tool)) return [];
              const publicName = publicToolName(tool.name);
              if (nextNames.has(publicName)) throw new Error("tool name collision");
              nextNames.set(publicName, tool.name);
              return [{ ...tool, name: publicName }];
            });
            toolNames = nextNames;
            return {
              ...result,
              tools
            };
          });
          break;

        case "tools/call": {
          const publicName = message.params?.name;
          const backendName = toolNames.get(publicName);
          if (
            typeof publicName !== "string" ||
            typeof backendName !== "string"
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
          forward(message, "tools/call", {
            ...message.params,
            name: backendName
          });
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
      child.kill();
    }
  });
}

export async function main(args = process.argv.slice(2)) {
  if (args[0] === "fixture" && args.length === 1) {
    runFixture();
    return;
  }

  if (args[0] === "mcp" && args[1] === "serve") {
    runProxy(args.slice(2));
    return;
  }

  throw new Error(
    "Usage: effectgate.mjs fixture | mcp serve [--source NAME]"
  );
}

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`[effectgate] ${error.message}\n`);
    process.exitCode = 2;
  });
}
