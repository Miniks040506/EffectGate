import assert from "node:assert/strict";
import test from "node:test";

import {
  COMPACT_CALL_TOOL,
  COMPACT_DESCRIBE_TOOL,
  COMPACT_SEARCH_TOOL
} from "../src/proxy/compact-mux.mjs";
import {
  COMPACT_CONTEXT_PROJECT_TOOL,
  COMPACT_CONTEXT_SEARCH_TOOL,
  CONTEXT_FETCH_TOOL,
  FIXTURE_TOOL,
  MCP_VERSION
} from "../src/proxy/effectgate.mjs";
import { RpcProcess } from "../src/testkit/rpc-process.mjs";

function structured(response) {
  assert.equal(response.error, undefined);
  assert.equal(response.result.isError, false);
  assert.deepEqual(
    JSON.parse(response.result.content[0].text),
    response.result.structuredContent
  );
  return response.result.structuredContent;
}

test("compact mux searches, describes, calls, and fetches admitted tools", async (context) => {
  assert.match(COMPACT_SEARCH_TOOL.description, /reuse returned refs/u);
  assert.match(COMPACT_DESCRIBE_TOOL.description, /reuse the schema/u);
  assert.match(COMPACT_CALL_TOOL.description, /without rediscovery/u);
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
    CONTEXT_FETCH_TOOL,
    COMPACT_CONTEXT_SEARCH_TOOL,
    COMPACT_CONTEXT_PROJECT_TOOL
  ]);
  assert.equal(firstPage.result.nextCursor, undefined);

  const searched = await proxy.request("tools/call", {
    name: COMPACT_SEARCH_TOOL.name,
    arguments: { query: "echo", limit: 10 }
  });
  const searchResult = structured(searched);
  assert.equal(searchResult.catalog_complete, true);
  assert.deepEqual(
    searchResult.matches.map(({ ref }) => ref),
    ["fixture__echo", "fixture__echo_again"]
  );

  const described = await proxy.request("tools/call", {
    name: COMPACT_DESCRIBE_TOOL.name,
    arguments: { ref: searchResult.matches[0].ref }
  });
  const describedResult = structured(described);
  assert.deepEqual(describedResult.input_schema, FIXTURE_TOOL.inputSchema);
  assert.deepEqual(describedResult.output_schema, FIXTURE_TOOL.outputSchema);

  const called = await proxy.request("tools/call", {
    name: COMPACT_CALL_TOOL.name,
    arguments: {
      ref: searchResult.matches[0].ref,
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
  const largeSearchResult = structured(largeSearch);
  assert.equal(largeSearchResult.catalog_complete, true);
  assert.equal(largeSearchResult.matches[0].ref, "fixture__large_log");
  const large = await proxy.request("tools/call", {
    name: COMPACT_CALL_TOOL.name,
    arguments: {
      ref: largeSearchResult.matches[0].ref,
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
