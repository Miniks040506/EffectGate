import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACT_CALL_TOOL,
  COMPACT_DESCRIBE_TOOL,
  COMPACT_SEARCH_TOOL
} from "../src/proxy/compact-mux.mjs";
import {
  CONTEXT_FETCH_TOOL,
  FIXTURE_TOOL,
  MCP_VERSION
} from "../src/proxy/effectgate.mjs";
import { RpcProcess } from "../src/testkit/rpc-process.mjs";

test("compact mux searches, describes, calls, and fetches admitted tools", async (context) => {
  const proxy = new RpcProcess([
    "mcp",
    "serve",
    "--profile",
    "compact_mux"
  ]);
  context.after(() => proxy.stop());

  await proxy.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "compact-mux-test", version: "1" }
  });
  proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });

  const firstPage = await proxy.request("tools/list");
  assert.deepEqual(firstPage.result.tools, [
    COMPACT_SEARCH_TOOL,
    COMPACT_DESCRIBE_TOOL,
    COMPACT_CALL_TOOL,
    CONTEXT_FETCH_TOOL
  ]);
  assert.equal(firstPage.result.nextCursor, "page-2");
  const secondPage = await proxy.request("tools/list", {
    cursor: firstPage.result.nextCursor
  });
  assert.deepEqual(secondPage.result, { tools: [] });

  const searched = await proxy.request("tools/call", {
    name: COMPACT_SEARCH_TOOL.name,
    arguments: { query: "echo", limit: 10 }
  });
  assert.equal(searched.result.catalog_complete, true);
  assert.deepEqual(
    searched.result.matches.map(({ ref }) => ref),
    ["fixture__echo", "fixture__echo_again"]
  );

  const described = await proxy.request("tools/call", {
    name: COMPACT_DESCRIBE_TOOL.name,
    arguments: { ref: searched.result.matches[0].ref }
  });
  assert.deepEqual(described.result.input_schema, FIXTURE_TOOL.inputSchema);
  assert.deepEqual(described.result.output_schema, FIXTURE_TOOL.outputSchema);

  const called = await proxy.request("tools/call", {
    name: COMPACT_CALL_TOOL.name,
    arguments: {
      ref: searched.result.matches[0].ref,
      arguments: { text: "through compact mux" }
    }
  });
  assert.deepEqual(called.result.structuredContent, {
    text: "through compact mux"
  });

  const largeSearch = await proxy.request("tools/call", {
    name: COMPACT_SEARCH_TOOL.name,
    arguments: { query: "large result" }
  });
  const large = await proxy.request("tools/call", {
    name: COMPACT_CALL_TOOL.name,
    arguments: {
      ref: largeSearch.result.matches[0].ref,
      arguments: { lines: 600 }
    }
  });
  const firstView = JSON.parse(large.result.content[0].text);
  assert.equal(firstView.status, "partial_view");
  const fetched = await proxy.request("tools/call", {
    name: CONTEXT_FETCH_TOOL.name,
    arguments: { cursor: firstView.retrieval.cursor }
  });
  const nextView = JSON.parse(fetched.result.content[0].text);
  assert.equal(
    nextView.citations[0].byte_start,
    firstView.citations[0].byte_end
  );

  const directTypedCall = await proxy.request("tools/call", {
    name: "fixture__echo",
    arguments: { text: "must not bypass compact call" }
  });
  assert.equal(directTypedCall.error.code, -32602);
  const unknownRef = await proxy.request("tools/call", {
    name: COMPACT_DESCRIBE_TOOL.name,
    arguments: { ref: "fixture__unknown" }
  });
  assert.equal(unknownRef.error.code, -32602);
  const invalidSearch = await proxy.request("tools/call", {
    name: COMPACT_SEARCH_TOOL.name,
    arguments: { query: "", hidden: "must not reflect" }
  });
  assert.equal(invalidSearch.error.code, -32602);
  assert.equal(JSON.stringify(invalidSearch).includes("must not reflect"), false);
  assert.equal(proxy.stderr, "");
});
