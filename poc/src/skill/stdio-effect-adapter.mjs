#!/usr/bin/env node

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import process from "node:process";

import {
  backendEnvironment,
  readBoundedJsonLines,
  validateResponse,
  writeMessage
} from "../proxy/jsonl-rpc.mjs";
import {
  EFFECTGATE_VERSION,
  MCP_VERSION
} from "../proxy/mcp-contract.mjs";

const SERVER_NAME = "effectgate-reviewed-effect-fixture";
const REQUEST_TIMEOUT_MS = 500;
const MAX_PENDING = 8;
const IDENTIFIER = /^eg_[A-Za-z0-9_-]{43}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;

export const STDIO_EFFECT_DRIVER =
  "effectgate.fixture.stdio-patch.v1";

function deepFreeze(value) {
  Object.freeze(value);
  for (const child of Object.values(value)) {
    if (child && typeof child === "object" && !Object.isFrozen(child)) {
      deepFreeze(child);
    }
  }
  return value;
}

export const PATCH_TOOL = deepFreeze({
  name: "filesystem.apply_patch",
  title: "Apply Reviewed Fixture Patch",
  description: "Persists one idempotent fixture patch digest.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["path", "content", "idempotency_key"],
    properties: {
      path: { type: "string", minLength: 1, maxLength: 512 },
      content: { type: "string", maxLength: 65536 },
      idempotency_key: { type: "string", pattern: IDENTIFIER.source }
    }
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
});

export const LOOKUP_TOOL = deepFreeze({
  name: "filesystem.patch.lookup",
  title: "Look Up Reviewed Fixture Patch",
  description: "Checks a fixture patch by its idempotency key.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["idempotency_key"],
    properties: {
      idempotency_key: { type: "string", pattern: IDENTIFIER.source }
    }
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
});

const sourceFile = fileURLToPath(import.meta.url);
const fixtureFile = fileURLToPath(
  new URL("./stdio-effect-fixture.mjs", import.meta.url)
);
const sourceFiles = [
  ["skill/stdio-effect-adapter.mjs", sourceFile],
  ["skill/stdio-effect-fixture.mjs", fixtureFile],
  [
    "proxy/jsonl-rpc.mjs",
    fileURLToPath(new URL("../proxy/jsonl-rpc.mjs", import.meta.url))
  ],
  [
    "proxy/mcp-contract.mjs",
    fileURLToPath(new URL("../proxy/mcp-contract.mjs", import.meta.url))
  ]
];
const sourceDigest = () => {
  const hash = createHash("sha256").update(
    "effectgate-reviewed-stdio-effect-source-v1\0"
  );
  for (const [name, file] of sourceFiles) {
    hash.update(name).update("\0").update(readFileSync(file)).update("\0");
  }
  return `sha256:${hash.digest("hex")}`;
};

export const stdioEffectAdapterSourceDigest = sourceDigest;

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

function safeResult(result, status) {
  return result && result.isError === false &&
    exact(result.structuredContent, ["status"]) &&
    result.structuredContent.status === status;
}

class StdioSession {
  #available = true;
  #child;
  #nextId = 0;
  #pending = new Map();

  constructor({ stateFile, targetPath, cwd, probe = false }) {
    const args = probe
      ? [fixtureFile, "--probe"]
      : [fixtureFile, "--state", stateFile, "--target", targetPath];
    this.#child = spawn(process.execPath, args, {
      cwd,
      env: backendEnvironment(),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    readBoundedJsonLines(this.#child.stdout, {
      onMessage: (message) => this.#receive(message),
      onError: () => this.#fail(),
      onEnd: () => this.#fail()
    });
    this.#child.stderr.resume();
    this.#child.on("error", () => this.#fail());
    this.#child.on("exit", () => this.#fail());
    this.#child.stdin.on("error", () => this.#fail());
  }

  async initialize(expectedDigest) {
    const initialized = await this.request("initialize", {
      protocolVersion: MCP_VERSION,
      clientInfo: { name: "effectgate", version: EFFECTGATE_VERSION }
    });
    if (!exact(initialized, [
      "protocolVersion", "capabilities", "serverInfo", "_meta"
    ]) ||
        initialized.protocolVersion !== MCP_VERSION ||
        !isDeepStrictEqual(
          initialized.capabilities,
          { tools: { listChanged: false } }
        ) ||
        !isDeepStrictEqual(initialized.serverInfo, {
          name: SERVER_NAME,
          version: EFFECTGATE_VERSION
        }) ||
        !exact(initialized._meta, ["source_digest"]) ||
        initialized._meta.source_digest !== expectedDigest) {
      throw new Error("reviewed backend identity mismatch");
    }
    this.notify("notifications/initialized", {});
    const catalog = await this.request("tools/list", {});
    if (!exact(catalog, ["tools"]) ||
        !isDeepStrictEqual(catalog.tools, [PATCH_TOOL, LOOKUP_TOOL])) {
      throw new Error("reviewed backend contract mismatch");
    }
  }

  request(method, params) {
    if (!this.#available || this.#pending.size >= MAX_PENDING) {
      return Promise.reject(new Error("reviewed backend unavailable"));
    }
    const id = `effectgate-${++this.#nextId}`;
    return new Promise((resolveRequest, rejectRequest) => {
      const timeout = setTimeout(() => {
        this.#pending.delete(id);
        rejectRequest(new Error("reviewed backend timeout"));
        this.#fail();
      }, REQUEST_TIMEOUT_MS);
      timeout.unref();
      this.#pending.set(id, {
        resolve: resolveRequest,
        reject: rejectRequest,
        timeout
      });
      try {
        writeMessage(this.#child.stdin, {
          jsonrpc: "2.0", id, method, params
        });
      } catch {
        this.#fail();
      }
    });
  }

  notify(method, params) {
    if (!this.#available) throw new Error("reviewed backend unavailable");
    writeMessage(this.#child.stdin, { jsonrpc: "2.0", method, params });
  }

  async close() {
    const exited = this.#child.exitCode === null
      ? once(this.#child, "exit")
      : Promise.resolve();
    this.#fail();
    await exited;
  }

  #receive(message) {
    if (!validateResponse(message)) {
      this.#fail();
      return;
    }
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.#pending.delete(message.id);
    if (message.error) {
      pending.reject(new Error("reviewed backend rejected request"));
    } else {
      pending.resolve(message.result);
    }
  }

  #fail() {
    if (!this.#available) return;
    this.#available = false;
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("reviewed backend unavailable"));
    }
    this.#pending.clear();
    this.#child.kill();
  }
}

export async function createReviewedStdioEffectBackend({
  stateFile, targetPath, cwd, expectedSourceDigest
} = {}) {
  if (!bounded(stateFile, 1024) || !bounded(targetPath, 512) ||
      !bounded(cwd, 1024) || !DIGEST.test(expectedSourceDigest ?? "") ||
      sourceDigest() !== expectedSourceDigest) {
    throw new TypeError("invalid reviewed stdio backend configuration");
  }
  let session;
  const start = async () => {
    const next = new StdioSession({ stateFile, targetPath, cwd });
    try {
      await next.initialize(expectedSourceDigest);
    } catch (error) {
      await next.close();
      throw error;
    }
    session = next;
    return next;
  };
  await start();
  return {
    async apply({ path, content, idempotencyKey }) {
      const result = await session.request("tools/call", {
        name: PATCH_TOOL.name,
        arguments: {
          path,
          content,
          idempotency_key: idempotencyKey
        }
      });
      if (!safeResult(result, "committed")) {
        throw new Error("reviewed backend mutation failed");
      }
    },
    async lookup(idempotencyKey) {
      let result;
      try {
        result = await session.request("tools/call", {
          name: LOOKUP_TOOL.name,
          arguments: { idempotency_key: idempotencyKey }
        });
      } catch {
        await session.close();
        result = await (await start()).request("tools/call", {
          name: LOOKUP_TOOL.name,
          arguments: { idempotency_key: idempotencyKey }
        });
      }
      if (!result || result.isError !== false ||
          !exact(result.structuredContent, ["status"]) ||
          !["found", "not_found"].includes(
            result.structuredContent.status
          )) {
        throw new Error("reviewed backend lookup failed");
      }
      return result.structuredContent.status;
    },
    close() {
      return session?.close() ?? Promise.resolve();
    }
  };
}

export async function probeReviewedStdioEffectBackend({
  cwd, expectedSourceDigest
} = {}) {
  if (!bounded(cwd, 1024) || !DIGEST.test(expectedSourceDigest ?? "") ||
      sourceDigest() !== expectedSourceDigest) {
    throw new TypeError("invalid reviewed stdio backend probe");
  }
  const session = new StdioSession({ cwd, probe: true });
  try {
    await session.initialize(expectedSourceDigest);
  } finally {
    await session.close();
  }
}
