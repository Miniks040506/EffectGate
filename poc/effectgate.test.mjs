import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  FIXTURE_SECOND_TOOL,
  FIXTURE_TOOL,
  MAX_FRAME_BYTES,
  MCP_VERSION,
  isPhase0SafeTool
} from "./effectgate.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRAM = join(HERE, "effectgate.mjs");

class RpcProcess {
  constructor(args) {
    this.child = spawn(process.execPath, [PROGRAM, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.buffer = "";
    this.messages = [];
    this.waiters = [];
    this.stderr = "";
    this.nextId = 0;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length === 0) continue;
        const message = JSON.parse(line);
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(message);
        else this.messages.push(message);
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = ++this.nextId;
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.next();
  }

  next() {
    if (this.messages.length > 0) return Promise.resolve(this.messages.shift());
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error(`Timed out waiting for response. stderr=${this.stderr}`));
      }, 5000);
      this.waiters.push({
        resolve(message) {
          clearTimeout(timeout);
          resolve(message);
        }
      });
    });
  }

  async stop() {
    if (this.child.exitCode !== null) return;
    this.child.stdin.end();
    const exited = once(this.child, "exit");
    setTimeout(() => this.child.kill(), 500).unref();
    await exited;
  }
}

test("fixture implements deterministic typed MCP calls", async (context) => {
  const server = new RpcProcess(["fixture"]);
  context.after(() => server.stop());

  const initialized = await server.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "phase0-test", version: "1" }
  });
  assert.equal(initialized.result.protocolVersion, MCP_VERSION);

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools, [FIXTURE_TOOL]);
  assert.equal(listed.result.nextCursor, "page-2");

  const secondPage = await server.request("tools/list", { cursor: "page-2" });
  assert.deepEqual(secondPage.result.tools, [FIXTURE_SECOND_TOOL]);

  const called = await server.request("tools/call", {
    name: "echo",
    arguments: { text: "deterministic" }
  });
  assert.deepEqual(called.result.structuredContent, { text: "deterministic" });
  assert.equal(called.result.isError, false);

  const unicode = "😀".repeat(4096);
  const unicodeCall = await server.request("tools/call", {
    name: "echo",
    arguments: { text: unicode }
  });
  assert.equal(unicodeCall.result.structuredContent.text, unicode);
});

test("proxy preserves the tool contract and namespaces only its name", async (context) => {
  const proxy = new RpcProcess(["mcp", "serve", "--source", "fixture"]);
  context.after(() => proxy.stop());

  const initialized = await proxy.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "phase0-test", version: "1" }
  });
  assert.equal(initialized.result.serverInfo.name, "effectgate-phase0");
  assert.deepEqual(initialized.result.capabilities, {
    tools: { listChanged: false }
  });

  const listed = await proxy.request("tools/list");
  const { name, ...proxiedContract } = listed.result.tools[0];
  const { name: fixtureName, ...fixtureContract } = FIXTURE_TOOL;
  assert.equal(name, `fixture__${fixtureName}`);
  assert.deepEqual(proxiedContract, fixtureContract);

  const called = await proxy.request("tools/call", {
    name,
    arguments: { text: "through EffectGate" }
  });
  assert.deepEqual(called.result.structuredContent, {
    text: "through EffectGate"
  });

  const secondPage = await proxy.request("tools/list", { cursor: "page-2" });
  assert.equal(secondPage.result.tools[0].name, "fixture__echo_again");

  const firstPageStillCallable = await proxy.request("tools/call", {
    name,
    arguments: { text: "page one remains admitted" }
  });
  assert.equal(
    firstPageStillCallable.result.structuredContent.text,
    "page one remains admitted"
  );
  assert.equal(proxy.stderr, "");
});

test("invalid and oversized frames fail safely and the server recovers", async (context) => {
  const server = new RpcProcess(["fixture"]);
  context.after(() => server.stop());

  server.child.stdin.write("{not-json}\n");
  const malformed = await server.next();
  assert.equal(malformed.error.code, -32700);

  server.send({
    jsonrpc: "2.0",
    id: { secret: "must-not-echo" },
    method: "ping"
  });
  const invalidId = await server.next();
  assert.equal(invalidId.id, null);
  assert.doesNotMatch(JSON.stringify(invalidId), /must-not-echo/);

  server.send({
    jsonrpc: "2.0",
    id: "x".repeat(129),
    method: "ping"
  });
  const oversizedId = await server.next();
  assert.equal(oversizedId.id, null);

  server.child.stdin.write(`${"x".repeat(MAX_FRAME_BYTES + 1)}\n`);
  const oversized = await server.next();
  assert.equal(oversized.error.code, -32001);

  const ping = await server.request("ping");
  assert.deepEqual(ping.result, {});
  assert.doesNotMatch(JSON.stringify([malformed, oversized]), /not-json/);
});

test("proxy rejects attempts to address a backend tool directly", async (context) => {
  const proxy = new RpcProcess(["mcp", "serve", "--source", "fixture"]);
  context.after(() => proxy.stop());

  const direct = await proxy.request("tools/call", {
    name: "echo",
    arguments: { text: "bypass" }
  });
  assert.equal(direct.error.code, -32602);

  await proxy.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "phase0-test", version: "1" }
  });
  await proxy.request("tools/list");

  const invented = await proxy.request("tools/call", {
    name: "fixture__invented",
    arguments: { text: "bypass" }
  });
  assert.equal(invented.error.code, -32602);
});

test("Phase 0 admits only declared safe read tools", () => {
  assert.equal(isPhase0SafeTool(FIXTURE_TOOL), true);
  assert.equal(
    isPhase0SafeTool({
      ...FIXTURE_TOOL,
      annotations: { ...FIXTURE_TOOL.annotations, readOnlyHint: false }
    }),
    false
  );
  assert.equal(
    isPhase0SafeTool({
      ...FIXTURE_TOOL,
      annotations: { ...FIXTURE_TOOL.annotations, openWorldHint: true }
    }),
    false
  );
});

test("Phase 0 refuses arbitrary backend commands", () => {
  const result = spawnSync(
    process.execPath,
    [PROGRAM, "mcp", "serve", "--", "unreviewed-backend"],
    { encoding: "utf8", windowsHide: true }
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Usage:/);
});
