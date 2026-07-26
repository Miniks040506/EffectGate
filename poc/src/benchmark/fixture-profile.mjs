import { performance } from "node:perf_hooks";
import { join, resolve } from "node:path";

import { BYTE_PROXY_COUNTER } from "../budget/token-counter.mjs";
import {
  EFFECTGATE_VERSION,
  MCP_VERSION
} from "../proxy/effectgate.mjs";
import {
  COMPACT_CALL_TOOL,
  COMPACT_DESCRIBE_TOOL,
  COMPACT_SEARCH_TOOL
} from "../proxy/compact-mux.mjs";
import { RpcProcess } from "../testkit/rpc-process.mjs";
import { BENCHMARK_PROFILES } from "./paired-harness.mjs";

export const SMALL_READ_PAYLOAD =
  "effectgate-small-read:" + "x".repeat(779);

function failure(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function resultOf(response) {
  if (
    response === null ||
    typeof response !== "object" ||
    response.error !== undefined ||
    response.result === undefined
  ) {
    throw failure("protocol_error");
  }
  return response.result;
}

function validContext(context) {
  return (
    context !== null &&
    typeof context === "object" &&
    /^run_[a-f0-9]{64}$/u.test(context.runId) &&
    Object.hasOwn(BENCHMARK_PROFILES, context.profile) &&
    context.ledgerProfile === BENCHMARK_PROFILES[context.profile]
  );
}

export async function runFixtureProfile(
  context,
  {
    ledgerDirectory,
    clock = () => performance.now()
  } = {}
) {
  if (
    !validContext(context) ||
    typeof ledgerDirectory !== "string" ||
    ledgerDirectory.length < 1 ||
    Buffer.byteLength(ledgerDirectory, "utf8") > 1024 ||
    ledgerDirectory.includes("\0") ||
    typeof clock !== "function"
  ) {
    throw new TypeError("invalid fixture benchmark configuration");
  }
  const compact = context.profile === "P2_EG_MUX";
  const proxied = context.profile === "P1_EG_TYPED" || compact;
  const eager = context.profile === "P3_EAGER_DIAGNOSTIC";
  const ledgerFile = join(resolve(ledgerDirectory), `${context.runId}.jsonl`);
  const args = proxied
    ? [
        "mcp",
        "serve",
        "--source",
        "fixture",
        "--token-ledger",
        ledgerFile,
        "--run-id",
        context.runId,
        "--profile",
        context.ledgerProfile
      ]
    : ["fixture"];
  const startedAt = clock();
  const process = new RpcProcess(args);
  try {
    resultOf(await process.request("initialize", {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: {
        name: "effectgate-benchmark",
        version: EFFECTGATE_VERSION
      }
    }));
    process.send({
      jsonrpc: "2.0",
      method: "notifications/initialized"
    });

    const catalogs = [];
    let catalog = resultOf(await process.request("tools/list"));
    catalogs.push(catalog);
    while ((eager || compact) && typeof catalog.nextCursor === "string") {
      catalog = resultOf(
        await process.request("tools/list", { cursor: catalog.nextCursor })
      );
      catalogs.push(catalog);
    }

    const compactResults = [];
    let callName = proxied ? "fixture__echo" : "echo";
    let callArguments = { text: SMALL_READ_PAYLOAD };
    if (compact) {
      const searched = resultOf(await process.request("tools/call", {
        name: COMPACT_SEARCH_TOOL.name,
        arguments: { query: "deterministic echo", limit: 8 }
      }));
      const ref = searched.matches?.find(
        (match) => match.ref === "fixture__echo"
      )?.ref;
      if (ref === undefined) throw failure("capability_not_found");
      const described = resultOf(await process.request("tools/call", {
        name: COMPACT_DESCRIBE_TOOL.name,
        arguments: { ref }
      }));
      compactResults.push(searched, described);
      callName = COMPACT_CALL_TOOL.name;
      callArguments = {
        ref,
        arguments: { text: SMALL_READ_PAYLOAD }
      };
    }
    const called = resultOf(await process.request("tools/call", {
      name: callName,
      arguments: callArguments
    }));
    compactResults.push(called);
    const catalogContent = catalogs.map(JSON.stringify).join("\n");
    const resultContent = compactResults.map(JSON.stringify).join("\n");
    return {
      task_success:
        called.isError === false &&
        called.structuredContent?.text === SMALL_READ_PAYLOAD,
      latency_ms: clock() - startedAt,
      fetch_count: 0,
      tool_call_count: compact ? 3 : 1,
      tool_schema_tokens: BYTE_PROXY_COUNTER.measure({
        content: catalogContent
      }),
      tool_result_tokens: BYTE_PROXY_COUNTER.measure({
        content: resultContent
      })
    };
  } finally {
    await process.stop();
  }
}
