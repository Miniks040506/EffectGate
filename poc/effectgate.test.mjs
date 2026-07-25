import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CONTEXT_FETCH_TOOL,
  EFFECTGATE_VERSION,
  FIXTURE_LARGE_LOG_TOOL,
  FIXTURE_SECOND_TOOL,
  FIXTURE_TOOL,
  MAX_FRAME_BYTES,
  MAX_TOOL_RESULT_BYTES,
  MCP_VERSION,
  buildFixtureLog,
  isSafeReadTool
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
    clientInfo: { name: "preview-test", version: "1" }
  });
  assert.equal(initialized.result.protocolVersion, MCP_VERSION);
  server.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const listed = await server.request("tools/list");
  assert.deepEqual(listed.result.tools, [FIXTURE_TOOL]);
  assert.equal(listed.result.nextCursor, "page-2");

  const secondPage = await server.request("tools/list", { cursor: "page-2" });
  assert.deepEqual(secondPage.result.tools, [
    FIXTURE_SECOND_TOOL,
    FIXTURE_LARGE_LOG_TOOL
  ]);

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
    clientInfo: { name: "preview-test", version: "1" }
  });
  assert.deepEqual(initialized.result.serverInfo, {
    name: "effectgate-preview",
    version: EFFECTGATE_VERSION
  });
  assert.deepEqual(initialized.result.capabilities, {
    tools: { listChanged: false }
  });
  assert.equal((await proxy.request("tools/list")).error.code, -32007);
  proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });

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

  const refreshId = ++proxy.nextId;
  const staleCallId = ++proxy.nextId;
  proxy.child.stdin.write(
    `${JSON.stringify({
      jsonrpc: "2.0",
      id: refreshId,
      method: "tools/list",
      params: {}
    })}\n${JSON.stringify({
      jsonrpc: "2.0",
      id: staleCallId,
      method: "tools/call",
      params: {
        name,
        arguments: { text: "must wait for refreshed admission" }
      }
    })}\n`
  );
  const refreshResponses = [await proxy.next(), await proxy.next()];
  assert.ok(refreshResponses.find((response) => response.id === refreshId).result);
  assert.equal(
    refreshResponses.find((response) => response.id === staleCallId).error.code,
    -32602
  );
  assert.equal(proxy.stderr, "");
});

test("large text is losslessly paged through opaque Context View cursors", async (context) => {
  const proxy = new RpcProcess(["mcp", "serve", "--source", "fixture"]);
  context.after(() => proxy.stop());

  await proxy.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "context-view-test", version: "1" }
  });
  proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const repeatedInitialize = await proxy.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "second-session", version: "1" }
  });
  assert.deepEqual(repeatedInitialize.error, {
    code: -32600,
    message: "This MCP session is already initialized."
  });

  const firstPage = await proxy.request("tools/list");
  assert.deepEqual(
    firstPage.result.tools.find((tool) => tool.name === CONTEXT_FETCH_TOOL.name),
    CONTEXT_FETCH_TOOL
  );
  const secondPage = await proxy.request("tools/list", { cursor: "page-2" });
  const largeLog = secondPage.result.tools.find(
    (tool) => tool.name === "fixture__large_log"
  );
  assert.equal(largeLog.outputSchema, undefined);

  const small = await proxy.request("tools/call", {
    name: largeLog.name,
    arguments: { lines: 1 }
  });
  assert.equal(small.result.content[0].text, buildFixtureLog(1));

  const oversizedStructured = await proxy.request("tools/call", {
    name: largeLog.name,
    arguments: { lines: 1000, includeStructuredCopy: true }
  });
  assert.deepEqual(oversizedStructured.error, {
    code: -32004,
    message: "The backend returned an invalid response."
  });
  assert.doesNotMatch(
    JSON.stringify(oversizedStructured),
    /bounded context evidence/
  );
  assert.deepEqual((await proxy.request("ping")).result, {});

  const lines = 200;
  const expected = buildFixtureLog(lines);
  let response = await proxy.request("tools/call", {
    name: largeLog.name,
    arguments: { lines }
  });
  let view = JSON.parse(response.result.content[0].text);
  const firstCursor = view.retrieval.cursor;
  const artifactId = view.artifact_id;
  const sessionId = view.session_id;
  const expectedDigest = `sha256:${createHash("sha256")
    .update(expected)
    .digest("hex")}`;
  let reconstructed = "";
  let expectedStart = 0;
  let firstFetchedView;

  const refreshed = await proxy.request("tools/list");
  const readmittedEcho = refreshed.result.tools.find(
    (tool) => tool.name === "fixture__echo"
  );
  const echoed = await proxy.request("tools/call", {
    name: readmittedEcho.name,
    arguments: { text: "catalog refresh preserves cursor state" }
  });
  assert.equal(
    echoed.result.structuredContent.text,
    "catalog refresh preserves cursor state"
  );

  for (;;) {
    assert.ok(
      Buffer.byteLength(JSON.stringify(response.result), "utf8") <=
        MAX_TOOL_RESULT_BYTES
    );
    const citation = view.citations[0];
    const pageBytes = Buffer.byteLength(view.content, "utf8");
    assert.equal(view.schema_version, "1.0.0");
    assert.match(view.view_id, /^view_[A-Za-z0-9_-]{16,128}$/);
    assert.equal(view.artifact_id, artifactId);
    assert.equal(view.session_id, sessionId);
    assert.equal(view.status, "partial_view");
    assert.equal(view.budget.applied_bytes, pageBytes);
    assert.ok(pageBytes <= view.budget.max_bytes);
    assert.equal(citation.byte_start, expectedStart);
    assert.equal(citation.byte_end, expectedStart + pageBytes);
    assert.equal(citation.artifact_id, artifactId);
    assert.equal(citation.source_digest, expectedDigest);
    assert.equal(artifactId, `art_${expectedDigest.slice("sha256:".length)}`);
    assert.equal(view.integrity.artifact_digest, citation.source_digest);
    const { view_digest: viewDigest, ...integrityBasis } = view.integrity;
    const calculatedViewDigest = `sha256:${createHash("sha256")
      .update(JSON.stringify({ ...view, integrity: integrityBasis }))
      .digest("hex")}`;
    assert.equal(viewDigest, calculatedViewDigest);
    assert.equal(view.diagnostics[0].code, "EG-VIEW-001");
    reconstructed += view.content;
    expectedStart = citation.byte_end;

    if (!view.retrieval.more_available) {
      assert.deepEqual(view.retrieval.operations, []);
      assert.equal(view.retrieval.cursor, undefined);
      break;
    }
    assert.deepEqual(view.retrieval.operations, ["fetch"]);
    assert.match(view.retrieval.cursor, /^cur_[A-Za-z0-9_-]{32,}$/);
    assert.ok(Number.isFinite(Date.parse(view.retrieval.expires_at)));
    const cursor = view.retrieval.cursor;
    response = await proxy.request("tools/call", {
      name: CONTEXT_FETCH_TOOL.name,
      arguments: { cursor }
    });
    view = JSON.parse(response.result.content[0].text);
    if (cursor === firstCursor) firstFetchedView = view;
  }

  assert.equal(reconstructed, expected);
  assert.equal(expectedStart, Buffer.byteLength(expected, "utf8"));

  const replayed = await proxy.request("tools/call", {
    name: CONTEXT_FETCH_TOOL.name,
    arguments: { cursor: firstCursor }
  });
  assert.deepEqual(
    JSON.parse(replayed.result.content[0].text),
    firstFetchedView
  );
  const invented = await proxy.request("tools/call", {
    name: CONTEXT_FETCH_TOOL.name,
    arguments: { cursor: `cur_${"x".repeat(32)}` }
  });
  const tooShort = await proxy.request("tools/call", {
    name: CONTEXT_FETCH_TOOL.name,
    arguments: { cursor: "cur_short" }
  });
  assert.deepEqual(invented.error, {
    code: -32602,
    message: "The retrieval cursor is invalid."
  });
  assert.deepEqual(tooShort.error, invented.error);
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

  const beforeInitialization = await proxy.request("tools/call", {
    name: "echo",
    arguments: { text: "bypass" }
  });
  assert.equal(beforeInitialization.error.code, -32007);
  assert.equal((await proxy.request("tools/list")).error.code, -32007);
  assert.equal((await proxy.request("ping")).error.code, -32007);

  await proxy.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "preview-test", version: "1" }
  });
  proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await proxy.request("tools/list");

  const direct = await proxy.request("tools/call", {
    name: "echo",
    arguments: { text: "bypass" }
  });
  assert.equal(direct.error.code, -32602);

  const invented = await proxy.request("tools/call", {
    name: "fixture__invented",
    arguments: { text: "bypass" }
  });
  assert.equal(invented.error.code, -32602);
});

test("the preview admits only declared safe read tools", () => {
  assert.equal(isSafeReadTool(FIXTURE_TOOL), true);
  assert.equal(
    isSafeReadTool({
      ...FIXTURE_TOOL,
      annotations: { ...FIXTURE_TOOL.annotations, readOnlyHint: false }
    }),
    false
  );
  assert.equal(
    isSafeReadTool({
      ...FIXTURE_TOOL,
      annotations: { ...FIXTURE_TOOL.annotations, openWorldHint: true }
    }),
    false
  );
});

test("the preview refuses arbitrary backend commands", () => {
  const result = spawnSync(
    process.execPath,
    [PROGRAM, "mcp", "serve", "--", "unreviewed-backend"],
    { encoding: "utf8", windowsHide: true }
  );
  assert.equal(result.status, 2);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /Usage:/);
});
