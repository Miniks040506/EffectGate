#!/usr/bin/env node

import { createHash } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { DatabaseSync } from "node:sqlite";

import {
  readBoundedJsonLines,
  writeMessage
} from "../proxy/jsonl-rpc.mjs";
import {
  EFFECTGATE_VERSION,
  MCP_VERSION
} from "../proxy/mcp-contract.mjs";
import {
  LOOKUP_TOOL,
  PATCH_TOOL,
  stdioEffectAdapterSourceDigest
} from "./stdio-effect-adapter.mjs";

const SERVER_NAME = "effectgate-reviewed-effect-fixture";
const IDENTIFIER = /^eg_[A-Za-z0-9_-]{43}$/u;

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function bounded(value, maximum) {
  return typeof value === "string" && value.length >= 1 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !value.includes("\0") && value === value.normalize("NFC");
}

function response(id, result) {
  return { jsonrpc: "2.0", id, result };
}

function toolResult(status, isError = false) {
  return {
    content: [{ type: "text", text: status }],
    structuredContent: { status },
    isError
  };
}

export function runReviewedStdioEffectFixture(args) {
  const probe = args.length === 1 && args[0] === "--probe";
  if (!probe && (args.length !== 4 || args[0] !== "--state" ||
      args[2] !== "--target" || !bounded(args[1], 1024) ||
      !bounded(args[3], 512))) {
    throw new TypeError("invalid reviewed fixture arguments");
  }
  const targetPath = probe ? "__effectgate_doctor_probe__" : args[3];
  const database = probe ? null : new DatabaseSync(resolve(args[1]));
  database?.exec(`
    CREATE TABLE IF NOT EXISTS fixture_config (
      singleton INTEGER PRIMARY KEY CHECK(singleton=1),
      target_path TEXT NOT NULL
    ) STRICT;
    CREATE TABLE IF NOT EXISTS fixture_patches (
      idempotency_key TEXT PRIMARY KEY,
      target_path TEXT NOT NULL,
      content_digest TEXT NOT NULL,
      committed_at TEXT NOT NULL
    ) STRICT;
  `);
  const configured = database?.prepare(
    "SELECT target_path FROM fixture_config WHERE singleton=1"
  ).get();
  if (configured && configured.target_path !== targetPath) {
    database.close();
    throw new Error("reviewed fixture target mismatch");
  }
  database?.prepare(
    "INSERT OR IGNORE INTO fixture_config VALUES (1, ?)"
  ).run(targetPath);
  let lifecycle = "new";
  const reply = (message) => writeMessage(process.stdout, message);
  readBoundedJsonLines(process.stdin, {
    onMessage(message) {
      const id = message?.id;
      if (message?.method === "notifications/initialized" &&
          lifecycle === "awaiting_initialized") {
        lifecycle = "ready";
        return;
      }
      if (message?.method === "initialize" && lifecycle === "new") {
        lifecycle = "awaiting_initialized";
        reply(response(id, {
          protocolVersion: MCP_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: SERVER_NAME, version: EFFECTGATE_VERSION },
          _meta: { source_digest: stdioEffectAdapterSourceDigest() }
        }));
        return;
      }
      if (lifecycle !== "ready") {
        reply(response(id, toolResult("not_initialized", true)));
        return;
      }
      if (message.method === "tools/list") {
        reply(response(id, { tools: [PATCH_TOOL, LOOKUP_TOOL] }));
        return;
      }
      if (probe) {
        reply(response(id, toolResult("probe_read_only", true)));
        return;
      }
      if (message.method !== "tools/call" ||
          !exact(message.params, ["name", "arguments"])) {
        reply(response(id, toolResult("invalid_request", true)));
        return;
      }
      const { name, arguments: input } = message.params;
      if (name === LOOKUP_TOOL.name &&
          exact(input, ["idempotency_key"]) &&
          IDENTIFIER.test(input.idempotency_key ?? "")) {
        const found = database.prepare(`SELECT 1 FROM fixture_patches
          WHERE idempotency_key=?`).get(input.idempotency_key);
        reply(response(id, toolResult(found ? "found" : "not_found")));
        return;
      }
      if (name !== PATCH_TOOL.name ||
          !exact(input, ["path", "content", "idempotency_key"]) ||
          input.path !== targetPath ||
          typeof input.content !== "string" ||
          Buffer.byteLength(input.content, "utf8") > 65536 ||
          !IDENTIFIER.test(input.idempotency_key ?? "")) {
        reply(response(id, toolResult("invalid_arguments", true)));
        return;
      }
      const contentDigest =
        `sha256:${createHash("sha256").update(input.content).digest("hex")}`;
      const existing = database.prepare(`SELECT target_path, content_digest
        FROM fixture_patches WHERE idempotency_key=?`
      ).get(input.idempotency_key);
      if (existing && (existing.target_path !== input.path ||
          existing.content_digest !== contentDigest)) {
        reply(response(id, toolResult("idempotency_conflict", true)));
        return;
      }
      if (!existing) {
        database.prepare(`INSERT INTO fixture_patches
          (idempotency_key, target_path, content_digest, committed_at)
          VALUES (?, ?, ?, ?)`).run(
          input.idempotency_key,
          input.path,
          contentDigest,
          new Date().toISOString()
        );
      }
      if (input.content === "EFFECTGATE_FIXTURE_TIMEOUT_BEFORE_RESPONSE") {
        return;
      }
      if (input.content === "EFFECTGATE_FIXTURE_CRASH_AFTER_COMMIT") {
        database.close();
        process.exit(70);
      }
      reply(response(id, toolResult("committed")));
    },
    onError() {
      database?.close();
      process.exit(2);
    },
    onEnd() {
      database?.close();
    }
  });
}

const sourceFile = fileURLToPath(import.meta.url);
if (process.argv[1] === sourceFile) {
  try {
    runReviewedStdioEffectFixture(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`[effectgate-fixture] ${error.message}\n`);
    process.exitCode = 2;
  }
}
