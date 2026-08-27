#!/usr/bin/env node

import process from "node:process";
import { fileURLToPath } from "node:url";

import { MCP_VERSION } from "./mcp-contract.mjs";
import {
  MAX_FRAME_BYTES,
  readBoundedJsonLines,
  validateResponse,
  writeMessage
} from "./jsonl-rpc.mjs";

const ENVIRONMENT_NAME = /^[A-Z][A-Z0-9_]{0,127}$/u;
const SESSION_ID = /^[\x21-\x7e]{1,256}$/u;
const TIMEOUT_MS = 9_000;
const USAGE = "Usage: streamable-http-json-bridge.mjs ENDPOINT " +
  "[--authorization-env NAME]";

export function normalizeHttpEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("invalid reviewed HTTP endpoint");
  }
  const loopback = ["127.0.0.1", "[::1]", "localhost"]
    .includes(endpoint.hostname);
  if ((endpoint.protocol !== "https:" &&
        !(endpoint.protocol === "http:" && loopback)) ||
      endpoint.username !== "" || endpoint.password !== "" ||
      endpoint.hash !== "") {
    throw new TypeError("invalid reviewed HTTP endpoint");
  }
  return endpoint;
}

function parseArguments(args) {
  if (args.length !== 1 &&
      !(args.length === 3 && args[1] === "--authorization-env" &&
        ENVIRONMENT_NAME.test(args[2]))) {
    throw new Error(USAGE);
  }
  return {
    endpoint: normalizeHttpEndpoint(args[0]),
    authorizationEnvironment: args[2]
  };
}

async function boundedJson(response) {
  if (!response.headers.get("content-type")?.toLowerCase()
    .startsWith("application/json")) {
    throw new Error("reviewed HTTP backend requires JSON responses");
  }
  const reader = response.body?.getReader();
  if (!reader) throw new Error("reviewed HTTP backend returned no response");
  const chunks = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_FRAME_BYTES) {
      await reader.cancel();
      throw new Error("reviewed HTTP backend response is too large");
    }
    chunks.push(value);
  }
  const bytes = Buffer.concat(chunks, total);
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  return JSON.parse(text);
}

export function runHttpJsonBridge(args = process.argv.slice(2)) {
  const { endpoint, authorizationEnvironment } = parseArguments(args);
  const authorization = authorizationEnvironment === undefined
    ? undefined
    : process.env[authorizationEnvironment];
  if (authorizationEnvironment !== undefined &&
      (typeof authorization !== "string" || authorization.length < 1 ||
        Buffer.byteLength(authorization, "utf8") > 8192 ||
        /[\r\n]/u.test(authorization))) {
    throw new Error("reviewed HTTP authorization is unavailable");
  }

  const requests = new Map();
  let sessionId;
  let initialized = false;
  let failed = false;

  function fail(id) {
    if (id === undefined) return;
    writeMessage(process.stdout, {
      jsonrpc: "2.0",
      id,
      error: {
        code: -32000,
        message: "The reviewed HTTP backend request failed."
      }
    });
  }

  async function send(message) {
    const id = message?.id;
    if (message?.method === "notifications/cancelled") {
      requests.get(message.params?.requestId)?.abort();
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    timer.unref();
    if (id !== undefined) requests.set(id, controller);
    try {
      const headers = {
        accept: "application/json, text/event-stream",
        "content-type": "application/json",
        origin: endpoint.origin,
        ...(authorization === undefined
          ? {}
          : { authorization })
      };
      if (initialized) {
        headers["mcp-protocol-version"] = MCP_VERSION;
        if (sessionId !== undefined) headers["mcp-session-id"] = sessionId;
      }
      const response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        redirect: "error",
        signal: controller.signal
      });
      if (id === undefined) {
        if (response.status !== 202) throw new Error("notification rejected");
        await response.body?.cancel();
        return;
      }
      if (!response.ok) throw new Error("request rejected");
      const result = await boundedJson(response);
      if (!validateResponse(result) || result.id !== id) {
        throw new Error("invalid reviewed HTTP response");
      }
      const returnedSession = response.headers.get("mcp-session-id");
      if (message.method === "initialize") {
        if (returnedSession !== null && !SESSION_ID.test(returnedSession)) {
          throw new Error("invalid reviewed HTTP session");
        }
        sessionId = returnedSession ?? undefined;
        initialized = true;
      } else if (returnedSession !== null && returnedSession !== sessionId) {
        throw new Error("reviewed HTTP session changed");
      }
      writeMessage(process.stdout, result);
    } catch {
      fail(id);
    } finally {
      clearTimeout(timer);
      if (id !== undefined) requests.delete(id);
    }
  }

  readBoundedJsonLines(process.stdin, {
    onMessage(message) {
      if (!failed) void send(message);
    },
    onError() {
      failed = true;
      for (const controller of requests.values()) controller.abort();
      process.exitCode = 1;
      process.stdin.pause();
    },
    onEnd() {
      for (const controller of requests.values()) controller.abort();
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    runHttpJsonBridge();
  } catch (error) {
    process.stderr.write(`[effectgate-http-bridge] ${error.message}\n`);
    process.exitCode = 2;
  }
}
