import assert from "node:assert/strict";
import test from "node:test";

import {
  CHUNKED_RESULT_META,
  CHUNKED_RESULT_METHOD,
  ChunkedResultReceiver,
  boundedResponseMessages
} from "../src/proxy/chunked-result.mjs";
import {
  CONTEXT_PROJECT_TOOL,
  FIXTURE_LARGE_LOG_TOOL,
  MCP_VERSION,
  MAX_TOOL_RESULT_BYTES,
  buildFixtureJsonl
} from "../src/proxy/effectgate.mjs";
import { MAX_FRAME_BYTES } from "../src/proxy/jsonl-rpc.mjs";
import { RpcProcess } from "../src/testkit/rpc-process.mjs";

test("chunked tool results preserve bytes inside bounded frames", () => {
  const result = {
    content: [{ type: "text", text: "marker=✓\n".repeat(150_000) }],
    isError: false
  };
  const messages = [...boundedResponseMessages(
    { jsonrpc: "2.0", id: "eg-1", result },
    4 * 1024 * 1024
  )];
  assert.ok(messages.length > 2);
  assert.ok(messages.every(
    (message) => Buffer.byteLength(`${JSON.stringify(message)}\n`, "utf8") <=
      MAX_FRAME_BYTES
  ));
  assert.ok(messages.slice(0, -1).every(
    ({ method }) => method === CHUNKED_RESULT_METHOD
  ));

  const receiver = new ChunkedResultReceiver("eg-1", 4 * 1024 * 1024);
  for (const message of messages.slice(0, -1)) receiver.accept(message);
  assert.deepEqual(receiver.finish(messages.at(-1).result), result);

  const invalid = structuredClone(messages.at(-1).result);
  invalid._meta[CHUNKED_RESULT_META].digest = `sha256:${"0".repeat(64)}`;
  assert.throws(() => receiver.finish(invalid), /digest mismatch/);
});

test("real proxy retains a multi-frame JSONL result and projects it", async (context) => {
  const lines = 20_000;
  assert.ok(Buffer.byteLength(buildFixtureJsonl(lines), "utf8") > MAX_FRAME_BYTES);
  const proxy = new RpcProcess(
    ["mcp", "serve", "--source", "fixture"],
    { timeoutMs: 30_000 }
  );
  context.after(() => proxy.stop());

  await proxy.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "chunked-result-test", version: "1" }
  });
  proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  await proxy.request("tools/list");
  await proxy.request("tools/list", { cursor: "page-2" });

  const initial = await proxy.request("tools/call", {
    name: `fixture__${FIXTURE_LARGE_LOG_TOOL.name}`,
    arguments: { lines, format: "jsonl" }
  });
  assert.ok(Buffer.byteLength(JSON.stringify(initial), "utf8") <= MAX_FRAME_BYTES);
  assert.ok(Buffer.byteLength(JSON.stringify(initial.result), "utf8") <=
    MAX_TOOL_RESULT_BYTES);
  const view = JSON.parse(initial.result.content[0].text);
  assert.equal(view.status, "partial_view");

  const projected = await proxy.request("tools/call", {
    name: CONTEXT_PROJECT_TOOL.name,
    arguments: {
      artifact_id: view.artifact_id,
      format: "jsonl",
      fields: ["/line", "/details/marker"],
      filter: { pointer: "/line", equals: lines - 1 },
      max_tokens: 64
    }
  });
  const projection = JSON.parse(projected.result.content[0].text);
  assert.deepEqual(JSON.parse(projection.content), {
    "/line": lines - 1,
    "/details/marker": "✓"
  });
  assert.equal(projection.record_citations.length, 1);
  assert.deepEqual((await proxy.request("ping")).result, {});
  assert.equal(proxy.stderr, "");
});
