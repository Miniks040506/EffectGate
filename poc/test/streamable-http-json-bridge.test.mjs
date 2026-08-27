import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MCP_VERSION } from "../src/proxy/mcp-contract.mjs";
import {
  REVIEWED_STDIO_DRIVER,
  reviewedFileDigest
} from "../src/proxy/reviewed-backend-config.mjs";
import {
  normalizeHttpEndpoint
} from "../src/proxy/streamable-http-json-bridge.mjs";
import { RpcProcess } from "../src/testkit/rpc-process.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const BRIDGE = join(
  HERE, "..", "src", "proxy", "streamable-http-json-bridge.mjs"
);
const TOOL = {
  name: "remote.echo",
  description: "Returns reviewed remote text.",
  inputSchema: {
    type: "object",
    properties: { text: { type: "string" } },
    required: ["text"],
    additionalProperties: false
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
};
const SERVER_INFO = { name: "reviewed-http-fixture", version: "1.0.0" };

test("reviewed HTTP JSON bridge preserves the pinned MCP session", async () => {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    requests.push({
      httpMethod: request.method,
      path: request.url,
      contentType: request.headers["content-type"],
      method: message.method,
      accept: request.headers.accept,
      origin: request.headers.origin,
      protocol: request.headers["mcp-protocol-version"],
      session: request.headers["mcp-session-id"]
    });
    if (message.id === undefined) {
      response.writeHead(202).end();
      return;
    }
    let result;
    if (message.method === "initialize") {
      result = {
        protocolVersion: MCP_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO
      };
      response.setHeader("MCP-Session-Id", "reviewed-session-1");
    } else if (message.method === "tools/list") {
      result = { tools: [TOOL] };
    } else if (message.method === "tools/call") {
      result = {
        content: [{ type: "text", text: `remote:${message.params.arguments.text}` }]
      };
    } else {
      response.writeHead(404).end();
      return;
    }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const root = mkdtempSync(join(tmpdir(), "effectgate-http-bridge-"));
  const configFile = join(root, "effectgate.json");
  const { port } = server.address();
  const endpoint = `http://127.0.0.1:${port}/mcp`;
  writeFileSync(configFile, JSON.stringify({
    schema_version: "1.0.0",
    driver: REVIEWED_STDIO_DRIVER,
    source: "remote",
    executable_path: process.execPath,
    executable_digest: reviewedFileDigest(process.execPath),
    argv: [BRIDGE, endpoint],
    working_directory: root,
    source_files: [
      { path: BRIDGE, digest: reviewedFileDigest(BRIDGE) }
    ],
    server_identity: SERVER_INFO,
    catalog: { tools: [TOOL] }
  }));

  const proxy = new RpcProcess([
    "mcp", "serve", "--config", configFile
  ], { timeoutMs: 15_000 });
  try {
    const initialized = await proxy.request("initialize", {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "http-bridge-test", version: "1" }
    });
    assert.equal(initialized.result.protocolVersion, MCP_VERSION);
    proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    const listed = await proxy.request("tools/list");
    assert.ok(listed.result.tools.some(({ name }) =>
      name === "remote__remote.echo"));
    const called = await proxy.request("tools/call", {
      name: "remote__remote.echo",
      arguments: { text: "hello" }
    });
    assert.equal(called.result.content[0].text, "remote:hello");
    assert.equal(requests[0].session, undefined);
    assert.equal(requests[0].protocol, undefined);
    assert.ok(requests.every(({ accept }) =>
      accept === "application/json, text/event-stream"));
    assert.ok(requests.every(({ httpMethod, path, contentType }) =>
      httpMethod === "POST" && path === "/mcp" &&
      contentType === "application/json"));
    assert.ok(requests.every(({ origin }) => origin === new URL(endpoint).origin));
    assert.ok(requests.slice(1).every(({ session, protocol }) =>
      session === "reviewed-session-1" && protocol === MCP_VERSION));
  } finally {
    await proxy.stop();
    await new Promise((resolve) => server.close(resolve));
    rmSync(root, { recursive: true, force: true });
  }
});

test("reviewed HTTP JSON bridge fails closed on SSE responses", async () => {
  const server = createServer((_request, response) => {
    response.setHeader("Content-Type", "text/event-stream");
    response.end("data: {}\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const { port } = server.address();
  const bridge = new RpcProcess([
    `http://127.0.0.1:${port}/mcp`
  ], { program: BRIDGE });
  try {
    const response = await bridge.request("initialize", {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "sse-denial-test", version: "1" }
    });
    assert.equal(response.error.code, -32000);
    assert.equal(response.error.message,
      "The reviewed HTTP backend request failed.");
  } finally {
    await bridge.stop();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("reviewed HTTP endpoint rejects unsafe cleartext and URL credentials", () => {
  assert.equal(normalizeHttpEndpoint("https://example.com/mcp").protocol, "https:");
  assert.equal(normalizeHttpEndpoint("http://localhost:3000/mcp").hostname, "localhost");
  for (const endpoint of [
    "http://example.com/mcp",
    "https://user:secret@example.com/mcp",
    "https://example.com/mcp#fragment",
    "file:///tmp/mcp"
  ]) {
    assert.throws(() => normalizeHttpEndpoint(endpoint), TypeError);
  }
});
