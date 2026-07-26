import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  ContextStore,
  InvalidArtifactError,
  InvalidCursorError
} from "./context-view.mjs";
import {
  CONTEXT_FETCH_TOOL,
  CONTEXT_PROJECT_TOOL,
  CONTEXT_SEARCH_TOOL,
  EFFECTGATE_VERSION,
  FIXTURE_LARGE_LOG_TOOL,
  FIXTURE_SECRETS,
  FIXTURE_SECOND_TOOL,
  FIXTURE_TOOL,
  MAX_FRAME_BYTES,
  MAX_TOOL_RESULT_BYTES,
  MCP_VERSION,
  boundToolResult,
  buildFixtureJsonl,
  buildFixtureLog,
  isSafeReadTool
} from "./effectgate.mjs";
import {
  CorruptArtifactError,
  FilesystemCas
} from "./filesystem-cas.mjs";

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
  assert.deepEqual(
    firstPage.result.tools.find(
      (tool) => tool.name === CONTEXT_SEARCH_TOOL.name
    ),
    CONTEXT_SEARCH_TOOL
  );
  assert.deepEqual(
    firstPage.result.tools.find(
      (tool) => tool.name === CONTEXT_PROJECT_TOOL.name
    ),
    CONTEXT_PROJECT_TOOL
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
    assert.equal(view.diagnostics[0].code, "EG-REDACT-001");
    assert.deepEqual(view.redactions, []);
    reconstructed += view.content;
    expectedStart = citation.byte_end;

    if (!view.retrieval.more_available) {
      assert.deepEqual(view.retrieval.operations, ["project", "search"]);
      assert.equal(view.retrieval.cursor, undefined);
      break;
    }
    assert.deepEqual(view.retrieval.operations, [
      "fetch",
      "project",
      "search"
    ]);
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

test("literal artifact search returns bounded cited windows", async (context) => {
  const proxy = new RpcProcess(["mcp", "serve", "--source", "fixture"]);
  const isolated = new RpcProcess(["mcp", "serve", "--source", "fixture"]);
  context.after(() => Promise.all([proxy.stop(), isolated.stop()]));

  for (const server of [proxy, isolated]) {
    await server.request("initialize", {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "search-test", version: "1" }
    });
    server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  const firstPage = await proxy.request("tools/list");
  const searchTool = firstPage.result.tools.find(
    (tool) => tool.name === CONTEXT_SEARCH_TOOL.name
  );
  const secondPage = await proxy.request("tools/list", { cursor: "page-2" });
  const largeLog = secondPage.result.tools.find(
    (tool) => tool.name === "fixture__large_log"
  );
  const raw = buildFixtureLog(200);
  const initial = await proxy.request("tools/call", {
    name: largeLog.name,
    arguments: { lines: 200 }
  });
  const artifactId = JSON.parse(initial.result.content[0].text).artifact_id;

  const uniqueQuery = "000100 level=INFO";
  const unique = await proxy.request("tools/call", {
    name: searchTool.name,
    arguments: {
      artifact_id: artifactId,
      query: uniqueQuery,
      context_lines: 0,
      max_tokens: 64
    }
  });
  const uniqueView = JSON.parse(unique.result.content[0].text);
  const lineStart = raw.indexOf(uniqueQuery);
  const lineEnd = raw.indexOf("\n", lineStart) + 1;
  assert.equal(uniqueView.status, "complete");
  assert.equal(uniqueView.content, raw.slice(lineStart, lineEnd));
  assert.deepEqual(uniqueView.citations[0], {
    artifact_id: artifactId,
    source_digest: uniqueView.integrity.artifact_digest,
    byte_start: Buffer.byteLength(raw.slice(0, lineStart), "utf8"),
    byte_end: Buffer.byteLength(raw.slice(0, lineEnd), "utf8")
  });
  assert.equal(uniqueView.diagnostics[0].code, "EG-SEARCH-001");
  assert.deepEqual(uniqueView.retrieval, {
    more_available: false,
    operations: ["project", "search"]
  });

  const repeated = await proxy.request("tools/call", {
    name: searchTool.name,
    arguments: {
      artifact_id: artifactId,
      query: "bounded context evidence",
      context_lines: 0,
      max_tokens: 64
    }
  });
  const repeatedView = JSON.parse(repeated.result.content[0].text);
  assert.equal(repeatedView.status, "partial_view");
  assert.ok(repeatedView.budget.applied_bytes <= 256);
  assert.deepEqual(repeatedView.retrieval.operations, [
    "fetch",
    "project",
    "search"
  ]);
  const searchCursor = repeatedView.retrieval.cursor;
  const next = await proxy.request("tools/call", {
    name: CONTEXT_FETCH_TOOL.name,
    arguments: { cursor: searchCursor }
  });
  const nextView = JSON.parse(next.result.content[0].text);
  assert.ok(
    nextView.citations[0].byte_start > repeatedView.citations[0].byte_start
  );
  const replayed = await proxy.request("tools/call", {
    name: CONTEXT_FETCH_TOOL.name,
    arguments: { cursor: searchCursor }
  });
  assert.deepEqual(
    JSON.parse(replayed.result.content[0].text),
    nextView
  );

  const absent = await proxy.request("tools/call", {
    name: searchTool.name,
    arguments: { artifact_id: artifactId, query: "not-present-anywhere" }
  });
  const absentView = JSON.parse(absent.result.content[0].text);
  assert.equal(absentView.status, "complete");
  assert.equal(absentView.content, "");
  assert.deepEqual(absentView.citations, []);

  await isolated.request("tools/list");
  const crossSession = await isolated.request("tools/call", {
    name: CONTEXT_SEARCH_TOOL.name,
    arguments: { artifact_id: artifactId, query: uniqueQuery }
  });
  const invented = await proxy.request("tools/call", {
    name: searchTool.name,
    arguments: {
      artifact_id: `art_${"f".repeat(64)}`,
      query: uniqueQuery
    }
  });
  assert.deepEqual(crossSession.error, invented.error);
  assert.deepEqual(invented.error, {
    code: -32602,
    message: "The artifact reference is invalid."
  });

  const invalid = await proxy.request("tools/call", {
    name: searchTool.name,
    arguments: { artifact_id: artifactId, query: "", context_lines: 6 }
  });
  assert.deepEqual(invalid.error, {
    code: -32602,
    message: "The search arguments are invalid."
  });
  assert.equal(proxy.stderr, "");
  assert.equal(isolated.stderr, "");
});

test("JSONL projection filters, selects, cites, redacts, and pages", async (context) => {
  const proxy = new RpcProcess(["mcp", "serve", "--source", "fixture"]);
  const isolated = new RpcProcess(["mcp", "serve", "--source", "fixture"]);
  context.after(() => Promise.all([proxy.stop(), isolated.stop()]));

  for (const server of [proxy, isolated]) {
    await server.request("initialize", {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "projection-test", version: "1" }
    });
    server.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  const catalog = await proxy.request("tools/list");
  const projectTool = catalog.result.tools.find(
    (tool) => tool.name === CONTEXT_PROJECT_TOOL.name
  );
  const listed = await proxy.request("tools/list", { cursor: "page-2" });
  const largeResult = listed.result.tools.find(
    (tool) => tool.name === "fixture__large_log"
  );
  const raw = buildFixtureJsonl(80, true);
  const initial = await proxy.request("tools/call", {
    name: largeResult.name,
    arguments: { lines: 80, format: "jsonl", includeSecrets: true }
  });
  const artifactId = JSON.parse(initial.result.content[0].text).artifact_id;
  const fields = [
    "/line",
    "/level",
    "/details/message",
    "/authorization"
  ];
  const expected = raw
    .trimEnd()
    .split("\n")
    .map((line) => JSON.parse(line))
    .filter((record) => record.level === "WARN")
    .slice(1, 9)
    .map((record) => ({
      "/line": record.line,
      "/level": record.level,
      "/details/message": record.details.message,
      ...(record.authorization
        ? { "/authorization": "Bearer [REDACTED]" }
        : {})
    }));

  let response = await proxy.request("tools/call", {
    name: projectTool.name,
    arguments: {
      artifact_id: artifactId,
      format: "jsonl",
      fields,
      filter: { pointer: "/level", equals: "WARN" },
      offset: 1,
      limit: 8,
      max_tokens: 64
    }
  });
  const projected = [];
  let firstCursor;
  let firstFetchedView;

  for (;;) {
    const serialized = JSON.stringify(response);
    for (const secret of FIXTURE_SECRETS) {
      assert.equal(serialized.includes(secret), false);
    }
    const view = JSON.parse(response.result.content[0].text);
    const records = view.content.length === 0
      ? []
      : view.content.trimEnd().split("\n").map((line) => JSON.parse(line));
    assert.equal(view.media_type, "application/x-ndjson");
    assert.equal(view.diagnostics[0].code, "EG-PROJECT-001");
    assert.ok(view.budget.applied_bytes <= 256);
    assert.equal(
      view.budget.applied_bytes,
      Buffer.byteLength(view.content, "utf8")
    );
    assert.equal(view.record_citations.length, records.length);

    for (let index = 0; index < records.length; index += 1) {
      const citation = view.citations[view.record_citations[index]];
      const source = JSON.parse(
        Buffer.from(raw, "utf8")
          .subarray(citation.byte_start, citation.byte_end)
          .toString("utf8")
      );
      assert.equal(source.level, "WARN");
      assert.equal(records[index]["/line"], source.line);
      projected.push(records[index]);
    }

    if (!view.retrieval.more_available) {
      assert.deepEqual(view.retrieval.operations, ["project", "search"]);
      break;
    }
    assert.deepEqual(view.retrieval.operations, [
      "fetch",
      "project",
      "search"
    ]);
    const cursor = view.retrieval.cursor;
    firstCursor ??= cursor;
    response = await proxy.request("tools/call", {
      name: CONTEXT_FETCH_TOOL.name,
      arguments: { cursor }
    });
    if (cursor === firstCursor) {
      firstFetchedView = JSON.parse(response.result.content[0].text);
    }
  }

  assert.deepEqual(projected, expected);
  assert.match(JSON.stringify(projected), /\[REDACTED\]/);
  const replayed = await proxy.request("tools/call", {
    name: CONTEXT_FETCH_TOOL.name,
    arguments: { cursor: firstCursor }
  });
  assert.deepEqual(
    JSON.parse(replayed.result.content[0].text),
    firstFetchedView
  );

  await isolated.request("tools/list");
  const crossSession = await isolated.request("tools/call", {
    name: CONTEXT_PROJECT_TOOL.name,
    arguments: { artifact_id: artifactId, format: "jsonl" }
  });
  const invented = await proxy.request("tools/call", {
    name: projectTool.name,
    arguments: {
      artifact_id: `art_${"f".repeat(64)}`,
      format: "jsonl"
    }
  });
  assert.deepEqual(crossSession.error, invented.error);
  assert.deepEqual(invented.error, {
    code: -32602,
    message: "The artifact reference is invalid."
  });

  const invalid = await proxy.request("tools/call", {
    name: projectTool.name,
    arguments: {
      artifact_id: artifactId,
      format: "jsonl",
      fields: ["/bad~2pointer"],
      limit: 0
    }
  });
  assert.deepEqual(invalid.error, {
    code: -32602,
    message: "The projection arguments are invalid."
  });
  assert.equal(proxy.stderr, "");
  assert.equal(isolated.stderr, "");
});

test("secret sentinels are redacted from every Context View page", async (context) => {
  const proxy = new RpcProcess(["mcp", "serve", "--source", "fixture"]);
  context.after(() => proxy.stop());

  await proxy.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "redaction-test", version: "1" }
  });
  proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const catalog = await proxy.request("tools/list");
  const searchTool = catalog.result.tools.find(
    (tool) => tool.name === CONTEXT_SEARCH_TOOL.name
  );
  const listed = await proxy.request("tools/list", { cursor: "page-2" });
  const largeLog = listed.result.tools.find(
    (tool) => tool.name === "fixture__large_log"
  );

  const raw = buildFixtureLog(200, true);
  for (const secret of FIXTURE_SECRETS) assert.ok(raw.includes(secret));
  const rawDigest = `sha256:${createHash("sha256").update(raw).digest("hex")}`;
  let response = await proxy.request("tools/call", {
    name: largeLog.name,
    arguments: { lines: 200, includeSecrets: true }
  });
  const secretArtifactId = JSON.parse(
    response.result.content[0].text
  ).artifact_id;
  let expectedStart = 0;
  const appliedRules = new Set();

  for (;;) {
    const serialized = JSON.stringify(response);
    for (const secret of FIXTURE_SECRETS) {
      assert.equal(serialized.includes(secret), false);
    }

    const view = JSON.parse(response.result.content[0].text);
    const citation = view.citations[0];
    assert.equal(citation.byte_start, expectedStart);
    assert.equal(citation.source_digest, rawDigest);
    assert.equal(view.integrity.artifact_digest, rawDigest);
    assert.equal(
      view.budget.applied_bytes,
      Buffer.byteLength(view.content, "utf8")
    );
    assert.equal(view.diagnostics[0].code, "EG-REDACT-001");
    for (const redaction of view.redactions) {
      assert.match(redaction.class, /^(credential|secret)$/);
      assert.ok(redaction.count >= 1);
      appliedRules.add(redaction.rule_id);
    }
    expectedStart = citation.byte_end;

    if (!view.retrieval.more_available) break;
    response = await proxy.request("tools/call", {
      name: CONTEXT_FETCH_TOOL.name,
      arguments: { cursor: view.retrieval.cursor }
    });
  }

  assert.equal(expectedStart, Buffer.byteLength(raw, "utf8"));
  assert.deepEqual(appliedRules, new Set([
    "bearer-token-v1",
    "prefixed-token-v1",
    "secret-assignment-v1"
  ]));

  for (const secret of FIXTURE_SECRETS) {
    const search = await proxy.request("tools/call", {
      name: searchTool.name,
      arguments: {
        artifact_id: secretArtifactId,
        query: secret,
        context_lines: 0,
        max_tokens: 64
      }
    });
    const serialized = JSON.stringify(search);
    for (const sentinel of FIXTURE_SECRETS) {
      assert.equal(serialized.includes(sentinel), false);
    }
    const searchView = JSON.parse(search.result.content[0].text);
    assert.ok(searchView.redactions.length >= 1);
    assert.match(searchView.content, /\[REDACTED\]|\*+/);
  }
  assert.equal(proxy.stderr, "");
});

test("Context Store preserves UTF-8 boundaries and pins live continuations", () => {
  let now = 1000;
  const store = new ContextStore({
    pageBytes: 5,
    maxArtifactBytes: 12,
    maxStoreBytes: 12,
    maxArtifacts: 2,
    maxCursors: 2,
    cursorTtlMs: 10,
    now: () => now
  });
  const first = store.ingest("A😀B😀");
  assert.equal(Buffer.byteLength(first.content, "utf8"), 5);
  assert.equal(first.content, "A😀");
  const liveCursor = first.retrieval.cursor;
  const firstObject = store.cas.objectPath(first.integrity.artifact_digest);
  assert.equal(existsSync(firstObject), true);
  assert.throws(() => store.ingest("12345678"), RangeError);
  assert.equal(existsSync(firstObject), true);

  const finalPage = store.fetch(liveCursor);
  assert.equal(finalPage.content, "B😀");
  assert.deepEqual(store.fetch(liveCursor), finalPage);
  const second = store.ingest("12345678");
  assert.equal(store.storedBytes, 8);
  assert.equal(existsSync(firstObject), false);

  const expiring = second.retrieval.cursor;
  now += 11;
  assert.throws(() => store.fetch(expiring), InvalidCursorError);

  const owner = new ContextStore({ pageBytes: 4 });
  const isolated = owner.ingest("A😀B");
  assert.equal(isolated.content, "A");
  assert.equal(isolated.citations[0].byte_end, 1);
  assert.throws(() => new ContextStore().fetch(isolated.retrieval.cursor));
  const emoji = owner.fetch(isolated.retrieval.cursor);
  assert.equal(emoji.content, "😀");
  assert.deepEqual(emoji.citations[0], {
    artifact_id: isolated.artifact_id,
    source_digest: isolated.integrity.artifact_digest,
    byte_start: 1,
    byte_end: 5
  });
  assert.equal(owner.fetch(emoji.retrieval.cursor).content, "B");

  assert.throws(
    () => new ContextStore().ingest("\ud800"),
    /Unicode scalar/
  );
  assert.throws(
    () => new ContextStore({ pageBytes: 262145 }),
    /pageBytes/
  );

  const capacity = new ContextStore({
    pageBytes: 4,
    maxArtifactBytes: 32,
    maxStoreBytes: 64,
    maxCursors: 2
  });
  const advancing = capacity.ingest("abcdefghijkl");
  assert.throws(
    () => capacity.ingest("mnopqrstuvwx"),
    /cursor capacity/
  );
  assert.equal(capacity.fetch(advancing.retrieval.cursor).content, "efgh");

  const sentinel = "Q".repeat(16);
  const rawSecret = `😀 api_key=${sentinel} suffix`;
  const redacting = new ContextStore({ pageBytes: 8 });
  let secretView = redacting.ingest(rawSecret);
  let expectedStart = 0;
  let redactionCount = 0;

  for (;;) {
    assert.equal(JSON.stringify(secretView).includes(sentinel), false);
    assert.equal(secretView.content.includes("Q"), false);
    assert.equal(secretView.citations[0].byte_start, expectedStart);
    assert.equal(
      secretView.budget.applied_bytes,
      Buffer.byteLength(secretView.content, "utf8")
    );
    redactionCount += secretView.redactions.reduce(
      (total, redaction) => total + redaction.count,
      0
    );
    expectedStart = secretView.citations[0].byte_end;
    if (!secretView.retrieval.more_available) break;
    secretView = redacting.fetch(secretView.retrieval.cursor);
  }
  assert.equal(expectedStart, Buffer.byteLength(rawSecret, "utf8"));
  assert.ok(redactionCount >= 2);

  const searchable = new ContextStore({ pageBytes: 64 });
  const unicodeQuery = "😀needle";
  const searchableRaw =
    `${"x".repeat(400)}${unicodeQuery}${"y".repeat(400)}`;
  const searchableView = searchable.ingest(searchableRaw);
  const searchView = searchable.search(
    searchableView.artifact_id,
    unicodeQuery,
    0,
    64
  );
  const matchStart = Buffer.byteLength(
    searchableRaw.slice(0, searchableRaw.indexOf(unicodeQuery)),
    "utf8"
  );
  const matchEnd = matchStart + Buffer.byteLength(unicodeQuery, "utf8");
  assert.equal(searchView.status, "partial_view");
  assert.ok(searchView.budget.applied_bytes <= 256);
  assert.ok(searchView.citations[0].byte_start <= matchStart);
  assert.ok(searchView.citations[0].byte_end >= matchEnd);
  assert.match(searchView.content, /😀needle/);
  assert.equal(
    searchView.diagnostics.at(-1).code,
    "EG-VIEW-001"
  );
  assert.throws(
    () => new ContextStore().search(
      searchableView.artifact_id,
      unicodeQuery
    ),
    InvalidArtifactError
  );

  const tooManySecrets = Array.from(
    { length: 4097 },
    (_, index) => `api_key=${String(index).padStart(4, "0")}${sentinel}`
  ).join("\n");
  assert.throws(
    () => new ContextStore().ingest(tooManySecrets),
    /redaction span limit/
  );
});

test("JSON projection handles escaped pointers, malformed input, and record budgets", () => {
  const store = new ContextStore({ pageBytes: 32 });
  const secret = `secret_${"S".repeat(20)}`;
  const raw = JSON.stringify([
    { id: 1, "a/b": { "m~n": "Ada" } },
    { id: 2, password: secret, blob: "x".repeat(300) }
  ]);
  const artifact = store.ingest(raw, "application/json");

  const escaped = store.project(artifact.artifact_id, {
    format: "json",
    fields: ["/a~1b/m~0n"],
    limit: 1,
    maxTokens: 64
  });
  assert.equal(escaped.content, '{"/a~1b/m~0n":"Ada"}\n');
  assert.deepEqual(escaped.record_citations, [0]);
  assert.deepEqual(escaped.citations[0], {
    artifact_id: artifact.artifact_id,
    source_digest: escaped.integrity.artifact_digest,
    byte_start: 0,
    byte_end: Buffer.byteLength(raw, "utf8")
  });

  const redacted = store.project(artifact.artifact_id, {
    format: "json",
    fields: ["/password"],
    filter: { pointer: "/id", equals: 2 },
    maxTokens: 64
  });
  assert.equal(JSON.stringify(redacted).includes(secret), false);
  assert.match(redacted.content, /\[REDACTED\]/);
  assert.ok(redacted.redactions.length >= 1);

  const oversized = store.project(artifact.artifact_id, {
    format: "json",
    fields: ["/blob"],
    filter: { pointer: "/id", equals: 2 },
    maxTokens: 64
  });
  assert.equal(oversized.status, "partial_view");
  assert.equal(oversized.content, "");
  assert.equal(oversized.retrieval.more_available, false);
  assert.ok(
    oversized.diagnostics.some(
      ({ code }) => code === "EG-PROJECT-BUDGET-001"
    )
  );

  const malformedJson = store.ingest('{"ok":1', "application/json");
  const fallback = store.project(malformedJson.artifact_id, {
    format: "json",
    maxTokens: 64
  });
  assert.equal(fallback.content, '{"ok":1');
  assert.equal(fallback.diagnostics[0].code, "EG-PROJECT-JSON-001");

  const jsonl = '{"id":1}\r\nbad😀\n{"id":2}\n';
  const jsonlArtifact = store.ingest(jsonl, "application/x-ndjson");
  const projected = store.project(jsonlArtifact.artifact_id, {
    format: "jsonl",
    fields: ["/id"],
    maxTokens: 64
  });
  assert.equal(projected.content, '{"/id":1}\n{"/id":2}\n');
  const malformed = projected.diagnostics.find(
    ({ code }) => code === "EG-PROJECT-JSONL-001"
  );
  assert.ok(malformed);
  const malformedCitation = projected.citations[malformed.citation_index];
  assert.equal(
    Buffer.from(jsonl, "utf8")
      .subarray(malformedCitation.byte_start, malformedCitation.byte_end)
      .toString("utf8"),
    "bad😀\n"
  );

  assert.throws(
    () =>
      store.project(artifact.artifact_id, {
        format: "json",
        fields: ["/id", "/id"]
      }),
    /projection options/
  );
  assert.throws(
    () =>
      new ContextStore().project(artifact.artifact_id, {
        format: "json"
      }),
    InvalidArtifactError
  );
  store.close();
});

test("filesystem CAS finalizes, recovers, deduplicates, and quarantines", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-cas-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const temporaryDirectory = join(directory, "tmp");
  mkdirSync(temporaryDirectory, { recursive: true });
  writeFileSync(
    join(temporaryDirectory, `upload_${"x".repeat(20)}.part`),
    "interrupted"
  );

  const bytes = Buffer.from("atomic UTF-8 artifact 😀", "utf8");
  const expectedDigest = `sha256:${createHash("sha256")
    .update(bytes)
    .digest("hex")}`;
  const cas = new FilesystemCas({
    directory,
    maxObjectBytes: 1024
  });
  assert.equal(cas.recoveredParts, 1);
  assert.deepEqual(readdirSync(temporaryDirectory), []);

  const stored = cas.put(
    [bytes.subarray(0, 7), bytes.subarray(7)],
    { expectedBytes: bytes.length, expectedDigest }
  );
  assert.deepEqual(stored, {
    digest: expectedDigest,
    bytes: bytes.length,
    deduplicated: false
  });
  const objectPath = cas.objectPath(expectedDigest);
  assert.equal(existsSync(objectPath), true);
  assert.deepEqual(cas.readRange(expectedDigest, 7, bytes.length), bytes.subarray(7));
  assert.deepEqual(readdirSync(temporaryDirectory), []);
  cas.close();

  const reopened = new FilesystemCas({
    directory,
    maxObjectBytes: 1024
  });
  assert.equal(
    reopened.put([bytes], {
      expectedBytes: bytes.length,
      expectedDigest
    }).deduplicated,
    true
  );
  writeFileSync(objectPath, "corrupt");
  assert.throws(
    () => reopened.readRange(expectedDigest, 0, 1, bytes.length),
    CorruptArtifactError
  );
  assert.equal(existsSync(objectPath), false);
  assert.equal(readdirSync(join(directory, "quarantine")).length, 1);
  reopened.close();

  const ephemeral = new FilesystemCas();
  const ephemeralRoot = ephemeral.root;
  ephemeral.close();
  assert.equal(existsSync(ephemeralRoot), false);
});

test("tool-result bounding fails closed and preserves error semantics", () => {
  const contextStore = new ContextStore();
  const boundedError = boundToolResult(
    {
      content: [{ type: "text", text: buildFixtureLog(200) }],
      isError: true
    },
    { contextStore, contextViewEligible: true }
  );
  assert.equal(boundedError.isError, true);
  assert.equal(
    JSON.parse(boundedError.content[0].text).status,
    "partial_view"
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(boundedError), "utf8") <=
      MAX_TOOL_RESULT_BYTES
  );

  const optionalIsError = boundToolResult(
    {
      content: [{ type: "text", text: buildFixtureLog(200) }]
    },
    { contextStore, contextViewEligible: true }
  );
  assert.equal(optionalIsError.isError, false);
  assert.equal(
    JSON.parse(optionalIsError.content[0].text).status,
    "partial_view"
  );

  const oversizedStructured = {
    content: [{ type: "text", text: "small" }],
    structuredContent: { blob: "x".repeat(MAX_TOOL_RESULT_BYTES) },
    isError: false
  };
  assert.throws(
    () =>
      boundToolResult(oversizedStructured, {
        contextStore,
        contextViewEligible: true
      }),
    /output limit/
  );
  assert.throws(
    () =>
      boundToolResult(
        {
          content: [
            { type: "text", text: "x".repeat(MAX_TOOL_RESULT_BYTES) }
          ],
          isError: false
        },
        { contextStore, contextViewEligible: false }
      ),
    /output limit/
  );
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
