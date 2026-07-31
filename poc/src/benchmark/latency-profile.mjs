#!/usr/bin/env node

import { arch, platform } from "node:os";
import { performance } from "node:perf_hooks";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";
import { MCP_VERSION } from "../proxy/effectgate.mjs";
import { RpcProcess } from "../testkit/rpc-process.mjs";
import { SMALL_READ_PAYLOAD } from "./fixture-profile.mjs";

const USAGE = "Usage: latency-profile.mjs [--samples COUNT]";

function round(value) {
  return Number(value.toFixed(6));
}

function summary(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const quantile = (probability) => {
    const position = (sorted.length - 1) * probability;
    const lower = Math.floor(position);
    const weight = position - lower;
    return round(
      sorted[lower] +
      (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower]) *
        weight
    );
  };
  return { median_ms: quantile(0.5), p95_ms: quantile(0.95) };
}

function validResult(response) {
  if (response?.error !== undefined || response?.result === undefined) {
    throw new Error("latency probe failed");
  }
  return response.result;
}

async function ready(args, publicName) {
  const rpc = new RpcProcess(args);
  try {
    validResult(await rpc.request("initialize", {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "effectgate-latency-profile", version: "1" }
    }));
    rpc.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    validResult(await rpc.request("tools/list"));
    return {
      rpc,
      ping: async () => validResult(await rpc.request("ping")),
      call: async () => {
        const result = validResult(await rpc.request("tools/call", {
          name: publicName,
          arguments: { text: SMALL_READ_PAYLOAD }
        }));
        if (
          result.isError !== false ||
          result.structuredContent?.text !== SMALL_READ_PAYLOAD
        ) {
          throw new Error("latency probe returned the wrong payload");
        }
        return result;
      }
    };
  } catch (error) {
    await rpc.stop();
    throw error;
  }
}

async function elapsed(operation, clock) {
  const started = clock();
  await operation();
  const duration = clock() - started;
  if (!Number.isFinite(duration) || duration <= 0) {
    throw new TypeError("invalid latency clock");
  }
  return duration;
}

async function paired(native, typed, operation, samples, clock) {
  const values = { native: [], typed: [] };
  for (let index = 0; index < samples; index += 1) {
    const order = index % 2 === 0
      ? [["native", native], ["typed", typed]]
      : [["typed", typed], ["native", native]];
    for (const [name, endpoint] of order) {
      values[name].push(await elapsed(endpoint[operation], clock));
    }
  }
  const nativeSummary = summary(values.native);
  const typedSummary = summary(values.typed);
  return {
    native: nativeSummary,
    typed: typedSummary,
    added_median_ms: round(
      typedSummary.median_ms - nativeSummary.median_ms
    ),
    added_p95_ms: round(typedSummary.p95_ms - nativeSummary.p95_ms),
    relative_median_overhead: round(
      typedSummary.median_ms / nativeSummary.median_ms - 1
    )
  };
}

export async function profileProxyLatency({
  samples = 100,
  warmups = 10,
  clock = () => performance.now()
} = {}) {
  if (
    !Number.isSafeInteger(samples) || samples < 1 || samples > 1_000 ||
    !Number.isSafeInteger(warmups) || warmups < 0 || warmups > 100 ||
    typeof clock !== "function"
  ) {
    throw new TypeError("invalid latency profile configuration");
  }
  const native = await ready(["fixture"], "echo");
  let typed;
  try {
    typed = await ready(
      ["mcp", "serve", "--source", "fixture"],
      "fixture__echo"
    );
    for (let index = 0; index < warmups; index += 1) {
      await native.ping();
      await typed.ping();
      await native.call();
      await typed.call();
    }
    const ping = await paired(native, typed, "ping", samples, clock);
    const smallRead = await paired(native, typed, "call", samples, clock);
    return deepFreeze({
      kind: "effectgate_proxy_latency_profile",
      schema_version: "1.0.0",
      machine_class: `${platform()}-${arch()}`,
      node_version: process.version,
      samples,
      warmups,
      ping,
      small_read: smallRead,
      tool_path_incremental_added_median_ms: round(
        smallRead.added_median_ms - ping.added_median_ms
      )
    });
  } finally {
    await Promise.all([
      native.rpc.stop(),
      ...(typed === undefined ? [] : [typed.rpc.stop()])
    ]);
  }
}

function parseArguments(args) {
  if (args.length === 0) return {};
  if (
    args.length !== 2 || args[0] !== "--samples" ||
    !/^\d{1,4}$/u.test(args[1]) ||
    Number(args[1]) < 1 || Number(args[1]) > 1_000
  ) {
    throw new Error(USAGE);
  }
  return { samples: Number(args[1]) };
}

export async function main(args = process.argv.slice(2)) {
  const result = await profileProxyLatency(parseArguments(args));
  process.stdout.write(`${canonicalJson(result)}\n`);
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[effectgate-latency] ${error.message}\n`);
    process.exitCode = 2;
  });
}
