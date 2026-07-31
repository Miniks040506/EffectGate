import assert from "node:assert/strict";
import {
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  MAX_FRAME_BYTES,
  MAX_PENDING_REQUESTS,
  MCP_VERSION
} from "../src/proxy/effectgate.mjs";
import {
  REVIEWED_STDIO_DRIVER,
  reviewedFileDigest
} from "../src/proxy/reviewed-backend-config.mjs";
import { RpcProcess } from "../src/testkit/rpc-process.mjs";
import {
  RESOURCE_BACKEND_IDENTITY,
  RESOURCE_BACKEND_TOOL
} from "./fixtures/resource-backend.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "fixtures", "resource-backend.mjs");
const REVIEWED_SOURCES = [
  FIXTURE,
  join(HERE, "..", "src", "proxy", "jsonl-rpc.mjs"),
  join(HERE, "..", "src", "proxy", "mcp-contract.mjs"),
  join(HERE, "..", "src", "config", "layered-config.mjs")
];

function writeConfiguration(root) {
  const file = join(root, "effectgate.json");
  writeFileSync(file, JSON.stringify({
    schema_version: "1.0.0",
    driver: REVIEWED_STDIO_DRIVER,
    source: "resource-fixture",
    executable_path: process.execPath,
    executable_digest: reviewedFileDigest(process.execPath),
    argv: [FIXTURE],
    working_directory: root,
    source_files: REVIEWED_SOURCES.map((path) => ({
      path,
      digest: reviewedFileDigest(path)
    })),
    server_identity: RESOURCE_BACKEND_IDENTITY,
    catalog: { tools: [RESOURCE_BACKEND_TOOL] }
  }));
  return file;
}

async function withReadyProxy(configuration, run) {
  const proxy = new RpcProcess([
    "mcp", "serve", "--config", configuration
  ]);
  try {
    const initialized = await proxy.request("initialize", {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "security-resilience-test", version: "1" }
    });
    assert.equal(initialized.result.protocolVersion, MCP_VERSION);
    proxy.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return await run(proxy);
  } finally {
    await proxy.stop();
  }
}

function sendBatch(proxy, requests) {
  proxy.child.stdin.write(
    `${requests.map((request) => JSON.stringify(request)).join("\n")}\n`
  );
}

function ping(id, mode, sentinel) {
  return {
    jsonrpc: "2.0",
    id,
    method: "ping",
    params: { effectgate_fixture: mode, sentinel }
  };
}

test("real proxy bounds frames, pending work, and backend crashes", async () => {
  const root = mkdtempSync(join(tmpdir(), "effectgate-resilience-"));
  const sentinel = "resource-secret-must-not-leak";
  try {
    const configuration = writeConfiguration(root);

    await withReadyProxy(configuration, async (proxy) => {
      proxy.child.stdin.write(Buffer.concat([
        Buffer.alloc(MAX_FRAME_BYTES + 1, 0x78),
        Buffer.from("\n")
      ]));
      const rejected = await proxy.next();
      assert.equal(rejected.error.code, -32001);
      assert.deepEqual((await proxy.request("ping")).result, {});
    });

    await withReadyProxy(configuration, async (proxy) => {
      sendBatch(proxy, Array.from(
        { length: MAX_PENDING_REQUESTS + 1 },
        (_, index) => ping(1_000 + index, "hold", sentinel)
      ));
      const rejected = await proxy.next();
      assert.equal(rejected.id, 1_000 + MAX_PENDING_REQUESTS);
      assert.equal(rejected.error.code, -32006);
      assert.equal(JSON.stringify(rejected).includes(sentinel), false);
    });

    await withReadyProxy(configuration, async (proxy) => {
      sendBatch(proxy, [
        ping(2_000, "hold", sentinel),
        ping(2_001, "hold", sentinel),
        ping(2_002, "crash", sentinel)
      ]);
      const failed = [];
      for (let index = 0; index < 3; index += 1) {
        failed.push(await proxy.next());
      }
      assert.deepEqual(
        failed.map(({ id, error }) => [id, error.code]),
        [[2_000, -32002], [2_001, -32002], [2_002, -32002]]
      );
      const unavailable = await proxy.request("ping");
      assert.equal(unavailable.error.code, -32002);
      assert.equal(
        JSON.stringify([...failed, unavailable]).includes(sentinel),
        false
      );
    });

    process.stdout.write(`${JSON.stringify({
      kind: "effectgate_crash_resource_evidence",
      oversized_frames: 1,
      post_overflow_recoveries: 1,
      max_pending_requests: MAX_PENDING_REQUESTS,
      overload_rejections: 1,
      crashed_pending_requests: 3,
      secret_reflections: 0
    })}\n`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
