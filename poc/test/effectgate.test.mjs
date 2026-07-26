import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  CONTEXT_PAGE_BYTES,
  ContextStore,
  InvalidArtifactError,
  InvalidCursorError
} from "../src/context/context-view.mjs";
import { CURSOR_PATTERN } from "../src/context/cursor-service.mjs";
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
  buildFixtureCsv,
  buildFixtureJsonl,
  buildFixtureLog,
  buildFixtureMarkdown,
  isSafeReadTool
} from "../src/proxy/effectgate.mjs";
import {
  CorruptArtifactError,
  FilesystemCas
} from "../src/storage/filesystem-cas.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRAM = join(HERE, "..", "src", "proxy", "effectgate.mjs");
const CONTEXT_VIEW_SCHEMA = JSON.parse(
  readFileSync(
    join(HERE, "..", "..", "contracts", "context-view.schema.json"),
    "utf8"
  )
);
const TOKEN_LEDGER_SCHEMA = JSON.parse(
  readFileSync(
    join(HERE, "..", "..", "contracts", "token-ledger.schema.json"),
    "utf8"
  )
);

function assertTokenCountContract(tokenCount) {
  const contract = TOKEN_LEDGER_SCHEMA.$defs.tokenCount;
  const allowed = new Set(Object.keys(contract.properties));
  assert.deepEqual(
    Object.keys(tokenCount).filter((key) => !allowed.has(key)),
    []
  );
  for (const key of contract.required) assert.ok(Object.hasOwn(tokenCount, key));
  assert.ok(contract.properties.basis.enum.includes(tokenCount.basis));
  assert.match(
    tokenCount.input_digest,
    /^sha256:[a-f0-9]{64}$/u
  );
}

function assertContextViewContract(view) {
  const allowed = new Set(Object.keys(CONTEXT_VIEW_SCHEMA.properties));
  assert.deepEqual(
    Object.keys(view).filter((key) => !allowed.has(key)),
    []
  );
  for (const key of CONTEXT_VIEW_SCHEMA.required) {
    assert.ok(Object.hasOwn(view, key), `missing Context View field: ${key}`);
  }
  const diagnostic = CONTEXT_VIEW_SCHEMA.$defs.diagnostic;
  const diagnosticKeys = new Set(Object.keys(diagnostic.properties));
  const codePattern = new RegExp(diagnostic.properties.code.pattern, "u");
  for (const item of view.diagnostics ?? []) {
    assert.match(item.code, codePattern);
    assert.deepEqual(
      Object.keys(item).filter((key) => !diagnosticKeys.has(key)),
      []
    );
  }
  if (view.record_citations) {
    for (const index of view.record_citations) {
      assert.ok(index >= 0 && index < view.citations.length);
    }
  }
  assert.equal(
    view.budget.applied_bytes,
    Buffer.byteLength(view.content, "utf8")
  );
  assert.ok(view.budget.applied_bytes <= view.budget.max_bytes);
  assert.ok(view.budget.applied_tokens <= view.budget.max_tokens);
  assertTokenCountContract(view.token_count);
  if (view.estimated_raw_token_count) {
    assertTokenCountContract(view.estimated_raw_token_count);
  }
  if (view.status === "partial_view") {
    assert.ok(view.estimated_raw_token_count);
    assert.ok(view.retrieval);
  }
  if (view.status === "complete" && view.retrieval) {
    assert.equal(view.retrieval.more_available, false);
  }
}

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

  const oversizedCatalog = await proxy.request("tools/list", {
    cursor: "oversized"
  });
  assert.deepEqual(oversizedCatalog.error, {
    code: -32005,
    message: `The response exceeds the ${MAX_TOOL_RESULT_BYTES}-byte result limit.`
  });
  assert.ok(
    Buffer.byteLength(JSON.stringify(oversizedCatalog), "utf8") <=
      MAX_TOOL_RESULT_BYTES
  );
  const unlisted = await proxy.request("tools/call", {
    name: "fixture__oversized_catalog",
    arguments: { text: "must not be admitted" }
  });
  assert.equal(unlisted.error.code, -32602);

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

test("proxy enforces a local-only session emitted-output limit", async (context) => {
  const proxy = new RpcProcess([
    "mcp",
    "serve",
    "--max-session-emitted-tokens",
    "1"
  ]);
  context.after(() => proxy.stop());

  await proxy.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "preview-test", version: "1" }
  });
  proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  for (let attempt = 0; attempt < 2; attempt += 1) {
    const listed = await proxy.request("tools/list");
    assert.equal(listed.error.code, -32008);
    assert.match(listed.error.message, /local emitted-output limit/);
    assert.match(
      listed.error.message,
      /host total context usage is not measured/
    );
  }
});

test("proxy persists token provenance without raw result content", async (context) => {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-ledger-proxy-"));
  const ledgerFile = join(directory, "tokens.jsonl");
  const proxy = new RpcProcess([
    "mcp",
    "serve",
    "--token-ledger",
    ledgerFile
  ]);
  context.after(async () => {
    await proxy.stop();
    rmSync(directory, { recursive: true, force: true });
  });

  await proxy.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "preview-test", version: "1" }
  });
  proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const firstCatalog = await proxy.request("tools/list");
  await proxy.request("tools/list", {
    cursor: firstCatalog.result.nextCursor
  });

  const called = await proxy.request("tools/call", {
    name: "fixture__large_log",
    arguments: { lines: 200, includeSecrets: true }
  });
  for (const secret of FIXTURE_SECRETS) {
    assert.equal(JSON.stringify(called).includes(secret), false);
  }

  const persisted = readFileSync(ledgerFile, "utf8");
  for (const secret of FIXTURE_SECRETS) {
    assert.equal(persisted.includes(secret), false);
  }
  const records = persisted.trimEnd().split("\n").map(JSON.parse);
  assert.deepEqual(
    records.slice(1).map(({ stage, direction }) => [stage, direction]),
    [
      ["tool_metadata", "to_host"],
      ["tool_metadata", "to_host"],
      ["backend_raw_result", "from_host"],
      ["first_view", "to_host"]
    ]
  );
  for (const entry of records.slice(1)) {
    assert.equal(entry.token_count.basis, "byte_proxy");
    assert.equal(entry.token_count.value, Math.ceil(entry.bytes / 4));
  }
  assert.equal(
    records.at(-1).safe_metadata.category,
    "context_view_tokens_emitted"
  );
  assert.match(records.at(-1).artifact_id, /^art_[a-f0-9]{64}$/u);
  assert.match(records.at(-1).view_id, /^view_[A-Za-z0-9_-]{24}$/u);
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
  const structuredView = JSON.parse(
    oversizedStructured.result.content[0].text
  );
  assert.equal(structuredView.status, "partial_view");
  assert.equal(structuredView.media_type, "application/json");
  assert.ok(
    structuredView.diagnostics.some(
      ({ code }) => code === "EG-VIEW-RESULT-001"
    )
  );
  assert.ok(
    structuredView.diagnostics.some(({ code }) => code === "EG-VIEW-002")
  );
  assert.ok(
    Buffer.byteLength(JSON.stringify(oversizedStructured.result), "utf8") <=
      MAX_TOOL_RESULT_BYTES
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
  const firstViewId = view.view_id;
  const firstNextPosition = view.citations[0].byte_end;
  const firstBudget = view.budget.max_bytes;
  const firstExpiry = view.retrieval.expires_at;
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
    assert.equal(
      view.budget.max_tokens,
      Math.ceil(view.budget.max_bytes / 4)
    );
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
    assert.ok(
      view.diagnostics.some(({ code }) => code === "EG-VIEW-002")
    );
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
    assert.match(view.retrieval.cursor, new RegExp(CURSOR_PATTERN, "u"));
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

  const [encodedClaims, mac] = firstCursor.slice(4).split(".");
  const claims = JSON.parse(
    Buffer.from(encodedClaims, "base64url").toString("utf8")
  );
  assert.equal(claims[0], 1);
  assert.equal(claims[1], artifactId);
  assert.equal(claims[2], firstViewId);
  assert.equal(claims[3], firstNextPosition);
  assert.equal(
    claims[4],
    `sha256:${createHash("sha256")
      .update(JSON.stringify({ type: "text" }))
      .digest("hex")}`
  );
  assert.equal(claims[5], firstBudget);
  assert.equal(
    claims.slice(6, 10).every(
      (binding) => /^[A-Za-z0-9_-]{43}$/u.test(binding)
    ),
    true
  );
  assert.equal(claims[10], Date.parse(firstExpiry));
  assert.match(claims[11], /^[A-Za-z0-9_-]{22}$/u);
  assert.equal(JSON.stringify(claims).includes(sessionId), false);

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
  const oversized = await proxy.request("tools/call", {
    name: CONTEXT_FETCH_TOOL.name,
    arguments: { cursor: `cur_${"A".repeat(2048)}.${"A".repeat(43)}` }
  });
  const alteredClaims = [...claims];
  alteredClaims[3] += 1;
  const alteredPayload = Buffer.from(
    JSON.stringify(alteredClaims),
    "utf8"
  ).toString("base64url");
  const tamperedPayload = await proxy.request("tools/call", {
    name: CONTEXT_FETCH_TOOL.name,
    arguments: { cursor: `cur_${alteredPayload}.${mac}` }
  });
  const tamperedMac = await proxy.request("tools/call", {
    name: CONTEXT_FETCH_TOOL.name,
    arguments: {
      cursor: `cur_${encodedClaims}.${mac[0] === "A" ? "B" : "A"}${mac.slice(1)}`
    }
  });
  assert.deepEqual(invented.error, {
    code: -32602,
    message: "The retrieval cursor is invalid."
  });
  assert.deepEqual(tooShort.error, invented.error);
  assert.deepEqual(oversized.error, invented.error);
  assert.deepEqual(tamperedPayload.error, invented.error);
  assert.deepEqual(tamperedMac.error, invented.error);
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
  assert.equal(uniqueView.budget.overflow, "none");
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
  assert.ok(
    repeatedView.diagnostics.some(({ code }) => code === "EG-VIEW-002")
  );
  assert.deepEqual(repeatedView.retrieval.operations, [
    "fetch",
    "project",
    "search"
  ]);
  const searchCursor = repeatedView.retrieval.cursor;
  assert.equal(
    Buffer.from(
      searchCursor.slice(4).split(".")[0],
      "base64url"
    ).toString("utf8").includes("bounded context evidence"),
    false
  );
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
  assert.equal(absentView.budget.overflow, "none");
  assert.equal(absentView.content, "");
  assert.deepEqual(absentView.citations, []);

  await isolated.request("tools/list");
  const crossCursor = await isolated.request("tools/call", {
    name: CONTEXT_FETCH_TOOL.name,
    arguments: { cursor: searchCursor }
  });
  const inventedCursor = await isolated.request("tools/call", {
    name: CONTEXT_FETCH_TOOL.name,
    arguments: {
      cursor: `cur_${"A".repeat(64)}.${"A".repeat(43)}`
    }
  });
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
  assert.deepEqual(crossCursor.error, inventedCursor.error);
  assert.deepEqual(inventedCursor.error, {
    code: -32602,
    message: "The retrieval cursor is invalid."
  });
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

test("CSV projection preserves records, citations, filters, and redaction", async (context) => {
  const proxy = new RpcProcess(["mcp", "serve", "--source", "fixture"]);
  context.after(() => proxy.stop());

  await proxy.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "csv-projection-test", version: "1" }
  });
  proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await proxy.request("tools/list");
  const listed = await proxy.request("tools/list", { cursor: "page-2" });
  const largeResult = listed.result.tools.find(
    (tool) => tool.name === "fixture__large_log"
  );
  const raw = buildFixtureCsv(80, true);
  const initial = await proxy.request("tools/call", {
    name: largeResult.name,
    arguments: { lines: 80, format: "csv", includeSecrets: true }
  });
  const artifactId = JSON.parse(initial.result.content[0].text).artifact_id;
  const expected = [6, 11, 16, 21, 26, 31, 36, 41].map((line) => ({
    line: String(line),
    message: "bounded, context evidence",
    authorization: line === 41 ? "[REDACTED]" : ""
  }));

  let response = await proxy.request("tools/call", {
    name: CONTEXT_PROJECT_TOOL.name,
    arguments: {
      artifact_id: artifactId,
      format: "csv",
      columns: ["line", "message", "authorization"],
      filter: { column: "level", equals: "WARN" },
      offset: 1,
      limit: 8,
      max_tokens: 64
    }
  });
  const projected = [];

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
    assert.equal(view.diagnostics[0].code, "EG-PROJECT-TABLE-001");
    assert.equal(view.record_citations.length, records.length);
    assert.ok(view.budget.applied_bytes <= 256);

    for (let index = 0; index < records.length; index += 1) {
      const citation = view.citations[view.record_citations[index]];
      const source = Buffer.from(raw, "utf8")
        .subarray(citation.byte_start, citation.byte_end)
        .toString("utf8");
      assert.ok(source.startsWith(`${records[index].line},WARN,`));
      assert.match(source, /"bounded, context evidence"/u);
      projected.push(records[index]);
    }

    if (!view.retrieval.more_available) break;
    response = await proxy.request("tools/call", {
      name: CONTEXT_FETCH_TOOL.name,
      arguments: { cursor: view.retrieval.cursor }
    });
  }

  assert.deepEqual(projected, expected);
  assert.match(JSON.stringify(projected), /\[REDACTED\]/u);
  const invalid = await proxy.request("tools/call", {
    name: CONTEXT_PROJECT_TOOL.name,
    arguments: {
      artifact_id: artifactId,
      format: "csv",
      fields: ["/line"],
      filter: { pointer: "/level", equals: "WARN" }
    }
  });
  assert.deepEqual(invalid.error, {
    code: -32602,
    message: "The projection arguments are invalid."
  });
  assert.equal(proxy.stderr, "");
});

test("Markdown projection indexes headings and extracts cited sections", async (context) => {
  const proxy = new RpcProcess(["mcp", "serve", "--source", "fixture"]);
  context.after(() => proxy.stop());

  await proxy.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "markdown-projection-test", version: "1" }
  });
  proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await proxy.request("tools/list");
  const listed = await proxy.request("tools/list", { cursor: "page-2" });
  const largeResult = listed.result.tools.find(
    (tool) => tool.name === "fixture__large_log"
  );
  const raw = buildFixtureMarkdown(80, true);
  const initial = await proxy.request("tools/call", {
    name: largeResult.name,
    arguments: { lines: 80, format: "markdown", includeSecrets: true }
  });
  const artifactId = JSON.parse(initial.result.content[0].text).artifact_id;

  let response = await proxy.request("tools/call", {
    name: CONTEXT_PROJECT_TOOL.name,
    arguments: {
      artifact_id: artifactId,
      format: "markdown",
      limit: 10,
      max_tokens: 64
    }
  });
  const headings = [];
  for (;;) {
    const view = JSON.parse(response.result.content[0].text);
    assert.equal(view.diagnostics[0].code, "EG-PROJECT-MARKDOWN-INDEX-001");
    assert.equal(view.media_type, "application/x-ndjson");
    const records = view.content.trimEnd().split("\n").filter(Boolean)
      .map((line) => JSON.parse(line));
    headings.push(...records);
    if (!view.retrieval.more_available) break;
    response = await proxy.request("tools/call", {
      name: CONTEXT_FETCH_TOOL.name,
      arguments: { cursor: view.retrieval.cursor }
    });
  }
  assert.deepEqual(
    headings.map(({ title }) => title),
    [
      "Fixture report",
      ...Array.from(
        { length: 9 },
        (_, index) => `Event ${String(index + 1).padStart(6, "0")}`
      )
    ]
  );

  const sectionResponse = await proxy.request("tools/call", {
    name: CONTEXT_PROJECT_TOOL.name,
    arguments: {
      artifact_id: artifactId,
      format: "markdown",
      heading: "Event 000041",
      max_tokens: 64
    }
  });
  const serialized = JSON.stringify(sectionResponse);
  for (const secret of FIXTURE_SECRETS) {
    assert.equal(serialized.includes(secret), false);
  }
  const section = JSON.parse(sectionResponse.result.content[0].text);
  assert.equal(section.media_type, "text/markdown");
  assert.equal(
    section.diagnostics[0].code,
    "EG-PROJECT-MARKDOWN-SECTION-001"
  );
  const rawStart = raw.indexOf("## Event 000041");
  const rawEnd = raw.indexOf("## Event 000042");
  assert.equal(
    section.content,
    raw.slice(rawStart, rawEnd).replace(
      FIXTURE_SECRETS[1],
      "[REDACTED]"
    )
  );
  assert.equal(section.record_citations.length, 5);
  for (const citationIndex of section.record_citations) {
    const citation = section.citations[citationIndex];
    assert.ok(citation.byte_start >= Buffer.byteLength(raw.slice(0, rawStart)));
    assert.ok(citation.byte_end <= Buffer.byteLength(raw.slice(0, rawEnd)));
  }

  const absent = await proxy.request("tools/call", {
    name: CONTEXT_PROJECT_TOOL.name,
    arguments: {
      artifact_id: artifactId,
      format: "markdown",
      heading: "Absent section"
    }
  });
  assert.equal(JSON.parse(absent.result.content[0].text).content, "");
  assert.equal(proxy.stderr, "");
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
  const echo = catalog.result.tools.find(
    (tool) => tool.name === "fixture__echo"
  );
  const listed = await proxy.request("tools/list", { cursor: "page-2" });
  const largeLog = listed.result.tools.find(
    (tool) => tool.name === "fixture__large_log"
  );

  for (const text of [
    `api_key=${FIXTURE_SECRETS[0]}`,
    `Bearer ${FIXTURE_SECRETS[1]}`,
    FIXTURE_SECRETS[2]
  ]) {
    const typed = await proxy.request("tools/call", {
      name: echo.name,
      arguments: { text }
    });
    assert.equal(typed.result.isError, true);
    assert.match(typed.result.content[0].text, /^EG-VIEW-002:/);
    assert.equal(JSON.stringify(typed).includes(text), false);
  }

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
  assert.throws(
    () => new ContextStore({ privacyPartition: "" }),
    /privacyPartition/
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
  assert.ok(
    searchView.diagnostics.some(({ code }) => code === "EG-VIEW-001")
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

test("opaque content is retained but withheld across every model-visible path", () => {
  const opaqueSource = Array.from({ length: 64 }, (_, index) =>
    createHash("sha256")
      .update(`effectgate-opaque-${index}`)
      .digest("base64url")
  ).join("");
  const store = new ContextStore();
  const view = store.ingest(opaqueSource);

  assert.equal(view.status, "unavailable");
  assert.equal(view.content, "");
  assert.equal(view.budget.applied_bytes, 0);
  assert.equal(view.budget.applied_tokens, 0);
  assert.equal(view.budget.overflow, "failed");
  assert.deepEqual(view.citations, []);
  assert.equal(view.retrieval, undefined);
  assert.equal(JSON.stringify(view).includes(opaqueSource.slice(0, 32)), false);
  assert.ok(
    view.diagnostics.some(({ code }) => code === "EG-VIEW-OPAQUE-001")
  );
  assert.ok(
    view.diagnostics.some(({ code }) => code === "EG-VIEW-002")
  );
  assert.match(
    view.diagnostics.find(({ code }) => code === "EG-VIEW-OPAQUE-001").message,
    /no summary was generated/
  );

  const searched = store.search(
    view.artifact_id,
    opaqueSource.slice(0, 16),
    0,
    64
  );
  const projected = store.project(view.artifact_id, {
    format: "json",
    maxTokens: 64
  });
  for (const guarded of [searched, projected]) {
    assert.equal(guarded.status, "unavailable");
    assert.equal(guarded.content, "");
    assert.equal(guarded.retrieval, undefined);
  }

  const wrapped = opaqueSource.replace(/(.{64})/gu, "$1\n");
  assert.equal(store.ingest(wrapped).status, "unavailable");
  const indentedArmor = opaqueSource
    .slice(0, 512)
    .match(/.{1,64}/gu)
    .map((line) => `    ${line}`)
    .join("\n");
  assert.equal(store.ingest(indentedArmor).status, "unavailable");
  const wrappedHex = Array.from({ length: 8 }, (_, index) =>
    createHash("sha256")
      .update(`effectgate-hex-${index}`)
      .digest("hex")
  ).join("\n");
  const shortArmor = opaqueSource.slice(0, 512).replace(/(.{64})/gu, "$1\n");
  const tailArmor = `${"level=INFO ordinary log\n".repeat(30)}${shortArmor}`;
  const pemBody = opaqueSource.slice(0, 88).replace(/(.{64})/gu, "$1\n");
  const pem =
    `-----BEGIN PRIVATE KEY-----\n${pemBody}\n` +
    "-----END PRIVATE KEY-----";
  for (const guarded of [wrappedHex, tailArmor, pem]) {
    const guardedView = store.ingest(guarded);
    assert.equal(guardedView.status, "unavailable");
    assert.equal(
      JSON.stringify(guardedView).includes(guarded.slice(-32)),
      false
    );
  }
  assert.equal(
    store.ingest("A".repeat(2048)).status,
    "complete"
  );
  const alphabet = "Aa0Bb1Cc2Dd3";
  assert.equal(
    store.ingest(alphabet.repeat(11).slice(0, 127)).status,
    "complete"
  );
  assert.equal(
    store.ingest(alphabet.repeat(11).slice(0, 128)).status,
    "unavailable"
  );
  assert.equal(
    store.ingest("ordinary text", "application/octet-stream").status,
    "unavailable"
  );
  const transitionStore = new ContextStore({ pageBytes: 8 });
  const mediaTransition = "same bytes, stricter media classification";
  const transition = transitionStore.ingest(mediaTransition);
  assert.throws(
    () =>
      transitionStore.ingest(
        mediaTransition,
        "application/octet-stream"
      ),
    /metadata conflicts/
  );
  assert.equal(
    transitionStore.fetch(transition.retrieval.cursor).content,
    mediaTransition.slice(8, 16)
  );
  transitionStore.close();

  const bounded = boundToolResult(
    {
      content: [{ type: "text", text: alphabet.repeat(11).slice(0, 128) }],
      isError: false
    },
    { contextStore: store, contextViewEligible: true }
  );
  assert.equal(JSON.parse(bounded.content[0].text).status, "unavailable");
  assert.equal(
    JSON.stringify(bounded).includes(alphabet.repeat(3)),
    false
  );
  const boundedPem = boundToolResult(
    { content: [{ type: "text", text: pem }], isError: false },
    { contextStore: store, contextViewEligible: true }
  );
  assert.equal(JSON.parse(boundedPem.content[0].text).status, "unavailable");
  assert.equal(JSON.stringify(boundedPem).includes(pemBody.slice(0, 32)), false);
  const structuredArmor = opaqueSource
    .slice(0, 512)
    .replace(/(.{64})/gu, "$1\n");
  const boundedStructured = boundToolResult(
    {
      content: [{ type: "text", text: "metadata only" }],
      structuredContent: { blob: structuredArmor },
      isError: false
    },
    { contextStore: store, contextViewEligible: true }
  );
  assert.equal(
    JSON.parse(boundedStructured.content[0].text).status,
    "unavailable"
  );
  assert.equal(
    JSON.stringify(boundedStructured).includes(
      structuredArmor.slice(0, 32)
    ),
    false
  );
  const tinyImage = "RUctMDI0LXRpbnktaW1hZ2U=";
  const boundedImage = boundToolResult(
    {
      content: [{ type: "image", data: tinyImage, mimeType: "image/png" }],
      isError: false
    },
    { contextStore: store, contextViewEligible: true }
  );
  const boundedImageView = JSON.parse(boundedImage.content[0].text);
  assert.equal(boundedImageView.status, "unavailable");
  assert.match(
    boundedImageView.diagnostics.find(
      ({ code }) => code === "EG-VIEW-RESULT-001"
    ).message,
    /model-visible content was withheld/
  );
  assert.equal(JSON.stringify(boundedImage).includes(tinyImage), false);
  store.close();

  const boundaryStore = new ContextStore();
  assert.equal(
    boundaryStore.requiresView("A".repeat(1024 * 1024), "text/plain"),
    false
  );
  assert.equal(
    boundaryStore.requiresView("A".repeat(1024 * 1024 + 1), "text/plain"),
    true
  );
  const oneMiB = alphabet.repeat(
    Math.ceil((1024 * 1024) / alphabet.length)
  ).slice(0, 1024 * 1024);
  const boundary = boundaryStore.ingest(
    oneMiB,
    "application/octet-stream"
  );
  assert.equal(boundary.status, "unavailable");
  assert.equal(boundary.content, "");
  assert.equal(boundary.retrieval, undefined);
  assert.equal(boundary.estimated_raw_token_count.value, 256 * 1024);
  assert.match(
    boundary.diagnostics
      .find(({ code }) => code === "EG-VIEW-OPAQUE-001")
      .message,
    /no summary was generated/
  );
  boundaryStore.close();
});

test("text, search, projection, and unavailable views match the public contract", () => {
  const store = new ContextStore({ pageBytes: 8 });
  const raw = '[{"id":1},{"id":2}]';
  const text = store.ingest(raw, "application/json");
  const search = store.search(text.artifact_id, '"id"', 0, 64);
  const projection = store.project(text.artifact_id, {
    format: "json",
    fields: ["/id"],
    maxTokens: 64
  });
  const malformedArtifact = store.ingest(
    '{"id":1}\nbad\n{"id":2}\n',
    "application/x-ndjson"
  );
  const diagnosticProjection = store.project(
    malformedArtifact.artifact_id,
    { format: "jsonl", fields: ["/id"], maxTokens: 64 }
  );
  const unavailable = store.ingest(
    "Aa0Bb1Cc2Dd3".repeat(11).slice(0, 128)
  );

  assert.equal(text.status, "partial_view");
  assert.equal(search.status, "partial_view");
  assert.equal(projection.status, "partial_view");
  assert.equal(unavailable.status, "unavailable");
  for (const view of [
    text,
    search,
    projection,
    diagnosticProjection,
    unavailable
  ]) {
    assertContextViewContract(view);
  }
  store.close();
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
  assert.ok(
    oversized.diagnostics.some(({ code }) => code === "EG-VIEW-002")
  );

  const malformedJson = store.ingest('{"ok":1', "application/json");
  const fallback = store.project(malformedJson.artifact_id, {
    format: "json",
    maxTokens: 64
  });
  assert.equal(fallback.content, '{"ok":1');
  assert.equal(fallback.diagnostics[0].code, "EG-PROJECT-JSON-001");

  const fallbackStore = new ContextStore({ pageBytes: 4096 });
  const malformedRaw = `{"broken":"${"x".repeat(700)}`;
  const malformedArtifact = fallbackStore.ingest(
    malformedRaw,
    "application/json"
  );
  let boundedFallback = fallbackStore.project(malformedArtifact.artifact_id, {
    format: "json",
    maxTokens: 64
  });
  let reconstructedFallback = "";
  for (;;) {
    assert.equal(boundedFallback.budget.max_tokens, 64);
    assert.equal(boundedFallback.budget.max_bytes, 256);
    assert.ok(boundedFallback.budget.applied_bytes <= 256);
    reconstructedFallback += boundedFallback.content;
    if (!boundedFallback.retrieval.more_available) break;
    boundedFallback = fallbackStore.fetch(
      boundedFallback.retrieval.cursor
    );
  }
  assert.equal(reconstructedFallback, malformedRaw);
  fallbackStore.close();

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

test("document projection handles CSV quoting, TSV, and fenced Markdown", () => {
  const store = new ContextStore({ pageBytes: 256 });
  const secret = `secret_${"S".repeat(20)}`;
  const csv =
    "id,note,password\r\n" +
    `1,\"comma, and \"\"quote\"\"\",\"${secret}\"\r\n` +
    "2,\"two\nlines\",ok\r\n";
  const artifact = store.ingest(csv, "text/csv");
  const first = store.project(artifact.artifact_id, {
    format: "csv",
    columns: ["id", "note", "password"],
    filter: { column: "id", equals: "1" },
    maxTokens: 64
  });
  assert.equal(JSON.stringify(first).includes(secret), false);
  assert.equal(
    first.content,
    '{"id":"1","note":"comma, and \\"quote\\"","password":"[REDACTED]"}\n'
  );
  const second = store.project(artifact.artifact_id, {
    format: "csv",
    columns: ["note"],
    filter: { column: "id", equals: "2" },
    maxTokens: 64
  });
  assert.equal(second.content, '{"note":"two\\nlines"}\n');
  const secondCitation = second.citations[second.record_citations[0]];
  assert.equal(
    Buffer.from(csv, "utf8")
      .subarray(secondCitation.byte_start, secondCitation.byte_end)
      .toString("utf8"),
    "2,\"two\nlines\",ok\r\n"
  );

  const tsv = "id\tname\n1\tAda\n2\tLin\n";
  const tsvArtifact = store.ingest(tsv, "text/tab-separated-values");
  const tsvView = store.project(tsvArtifact.artifact_id, {
    format: "tsv",
    columns: ["name"],
    filter: { column: "id", equals: "2" },
    maxTokens: 64
  });
  assert.equal(tsvView.content, '{"name":"Lin"}\n');

  const malformedCsv = `id,password\r\n1,\"${secret}`;
  const malformedArtifact = store.ingest(malformedCsv, "text/csv");
  assert.throws(
    () =>
      store.project(malformedArtifact.artifact_id, {
        format: "csv",
        columns: ["password"]
      }),
    /invalid document projection source/
  );
  const duplicate = store.ingest("id,id\n1,2\n", "text/csv");
  assert.throws(
    () => store.project(duplicate.artifact_id, { format: "csv" }),
    /invalid document projection source/
  );
  const ragged = store.ingest("id,name\n1\n", "text/csv");
  assert.throws(
    () => store.project(ragged.artifact_id, { format: "csv" }),
    /invalid document projection source/
  );

  const markdown =
    "# Alpha\nintro\n```md\n# fenced\n```\n## Child\nbody\n# Beta\nend\n";
  const markdownArtifact = store.ingest(markdown, "text/markdown");
  const index = store.project(markdownArtifact.artifact_id, {
    format: "markdown",
    maxTokens: 64
  });
  assert.deepEqual(
    index.content.trimEnd().split("\n").map((line) => JSON.parse(line).title),
    ["Alpha", "Child", "Beta"]
  );
  const section = store.project(markdownArtifact.artifact_id, {
    format: "markdown",
    heading: "Alpha",
    maxTokens: 64
  });
  assert.equal(section.content, markdown.slice(0, markdown.indexOf("# Beta")));

  assert.throws(
    () =>
      store.project(artifact.artifact_id, {
        format: "csv",
        columns: ["missing"]
      }),
    /projection options/
  );
  store.close();
});

test("filesystem CAS finalizes, recovers, deduplicates, and quarantines", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-cas-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const seed = new FilesystemCas({ directory, maxObjectBytes: 1024 });
  const temporaryDirectory = seed.tmpDirectory;
  seed.close();
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
  assert.equal(readdirSync(reopened.quarantineDirectory).length, 1);
  reopened.close();

  const ephemeral = new FilesystemCas();
  const ephemeralRoot = ephemeral.root;
  ephemeral.close();
  assert.equal(existsSync(ephemeralRoot), false);
});

test("CAS reuse and invalidation stay inside the privacy partition", (context) => {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-partition-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  const bytes = Buffer.from("partitioned artifact", "utf8");
  const expectedDigest = `sha256:${createHash("sha256")
    .update(bytes)
    .digest("hex")}`;
  const first = new FilesystemCas({
    directory,
    privacyPartition: "tenant-a"
  });
  const same = new FilesystemCas({
    directory,
    privacyPartition: "tenant-a"
  });
  const isolated = new FilesystemCas({
    directory,
    privacyPartition: "tenant-b"
  });
  assert.throws(
    () => new FilesystemCas({ directory, privacyPartition: "" }),
    /privacyPartition/
  );

  assert.equal(first.put([bytes], {
    expectedBytes: bytes.length,
    expectedDigest
  }).deduplicated, false);
  assert.equal(same.put([bytes], {
    expectedBytes: bytes.length,
    expectedDigest
  }).deduplicated, true);
  assert.equal(isolated.put([bytes], {
    expectedBytes: bytes.length,
    expectedDigest
  }).deduplicated, false);
  assert.equal(first.objectPath(expectedDigest), same.objectPath(expectedDigest));
  assert.notEqual(first.objectPath(expectedDigest), isolated.objectPath(expectedDigest));

  assert.equal(first.remove(expectedDigest), true);
  assert.equal(existsSync(same.objectPath(expectedDigest)), false);
  assert.deepEqual(
    isolated.readRange(expectedDigest, 0, bytes.length, bytes.length),
    bytes
  );
  for (const cas of [first, same, isolated]) cas.close();
});

test("artifact invalidation revokes cached and live retrieval cursors", () => {
  const store = new ContextStore({ pageBytes: 4 });
  const first = store.ingest("abcdefghijkl");
  const cursor = first.retrieval.cursor;

  const duplicate = store.ingest("abcdefghijkl");
  assert.equal(duplicate.artifact_id, first.artifact_id);
  assert.equal(store.artifacts.size, 1);
  const fetched = store.fetch(cursor);
  assert.equal(store.fetch(cursor), fetched);
  assert.equal(store.invalidate(first.artifact_id), true);
  assert.equal(store.invalidate(first.artifact_id), false);
  assert.throws(() => store.fetch(cursor), InvalidCursorError);
  assert.throws(
    () => store.fetch(fetched.retrieval.cursor),
    InvalidCursorError
  );
  assert.throws(
    () => store.fetch(duplicate.retrieval.cursor),
    InvalidCursorError
  );
  assert.throws(
    () => store.invalidate("not-an-artifact"),
    InvalidArtifactError
  );

  const reloaded = store.ingest("abcdefghijkl");
  assert.equal(reloaded.artifact_id, first.artifact_id);
  assert.notEqual(reloaded.view_id, first.view_id);
  store.close();
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
  const boundedStructured = boundToolResult(oversizedStructured, {
    contextStore,
    contextViewEligible: true
  });
  let structuredView = JSON.parse(boundedStructured.content[0].text);
  let reconstructed = "";
  for (;;) {
    assert.ok(
      structuredView.diagnostics.some(({ code }) => code === "EG-VIEW-002")
    );
    assert.ok(
      structuredView.budget.applied_bytes <=
        structuredView.budget.max_bytes
    );
    reconstructed += structuredView.content;
    if (!structuredView.retrieval.more_available) break;
    structuredView = contextStore.fetch(structuredView.retrieval.cursor);
  }
  assert.equal(reconstructed, JSON.stringify(oversizedStructured));
  assert.ok(
    structuredView.diagnostics.some(
      ({ code }) => code === "EG-VIEW-RESULT-001"
    )
  );

  const secret = `api_key=${"S".repeat(24)}`;
  const protectedResult = boundToolResult(
    { content: [{ type: "text", text: secret }], isError: false },
    { contextStore, contextViewEligible: true }
  );
  const protectedView = JSON.parse(protectedResult.content[0].text);
  assert.equal(protectedView.status, "complete");
  assert.equal(JSON.stringify(protectedResult).includes(secret), false);
  assert.match(protectedView.content, /\[REDACTED\]|\*+/);

  const typedOpaque = "Aa0Bb1Cc2Dd3".repeat(16);
  for (const isError of [false, true]) {
    const withheldTyped = boundToolResult(
      {
        content: [{ type: "text", text: "typed metadata" }],
        structuredContent: { blob: typedOpaque },
        isError
      },
      { contextStore, contextViewEligible: false }
    );
    assert.equal(withheldTyped.isError, true);
    assert.match(withheldTyped.content[0].text, /^EG-VIEW-002:/);
    assert.equal(JSON.stringify(withheldTyped).includes(typedOpaque), false);
  }

  assert.throws(
    () =>
      boundToolResult(
        { content: [{ type: "text", text: "invalid" }], isError: "false" },
        { contextStore, contextViewEligible: true }
      ),
    /invalid tool result/
  );

  const constrainedStore = new ContextStore({
    maxArtifactBytes: 64,
    maxStoreBytes: 64
  });
  const retentionFailure = boundToolResult(
    {
      content: [{ type: "text", text: "x".repeat(CONTEXT_PAGE_BYTES + 1) }],
      isError: false
    },
    { contextStore: constrainedStore, contextViewEligible: true }
  );
  assert.equal(retentionFailure.isError, true);
  assert.match(retentionFailure.content[0].text, /^EG-CAS-001:/);
  assert.equal(retentionFailure.content[0].text.includes("x".repeat(32)), false);
  constrainedStore.close();

  const cursorLimitedStore = new ContextStore({
    pageBytes: 4,
    maxCursors: 2
  });
  boundToolResult(
    {
      content: [{ type: "text", text: "a".repeat(CONTEXT_PAGE_BYTES + 1) }],
      isError: false
    },
    { contextStore: cursorLimitedStore, contextViewEligible: true }
  );
  const viewFailure = boundToolResult(
    {
      content: [{ type: "text", text: "b".repeat(CONTEXT_PAGE_BYTES + 1) }],
      isError: false
    },
    { contextStore: cursorLimitedStore, contextViewEligible: true }
  );
  assert.equal(viewFailure.isError, true);
  assert.match(viewFailure.content[0].text, /^EG-VIEW-001:/);
  cursorLimitedStore.close();

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
  contextStore.close();
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

  const invalidBudget = spawnSync(
    process.execPath,
    [
      PROGRAM,
      "mcp",
      "serve",
      "--max-session-emitted-tokens",
      "0"
    ],
    { encoding: "utf8", windowsHide: true }
  );
  assert.equal(invalidBudget.status, 2);
  assert.match(invalidBudget.stderr, /Usage:/);

  const directory = mkdtempSync(join(tmpdir(), "effectgate-ledger-startup-"));
  const ledgerFile = join(directory, "corrupt.jsonl");
  writeFileSync(ledgerFile, "not-a-ledger\n");
  const corruptLedger = spawnSync(
    process.execPath,
    [PROGRAM, "mcp", "serve", "--token-ledger", ledgerFile],
    { encoding: "utf8", timeout: 2000, windowsHide: true }
  );
  rmSync(directory, { recursive: true, force: true });
  assert.equal(corruptLedger.status, 2);
  assert.match(corruptLedger.stderr, /token ledger failed validation/);
});
