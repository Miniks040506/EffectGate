import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  EFFECTGATE_VERSION,
  MCP_VERSION
} from "../src/proxy/mcp-contract.mjs";
import {
  REVIEWED_STDIO_DRIVER,
  loadReviewedBackendConfig,
  reviewedFileDigest
} from "../src/proxy/reviewed-backend-config.mjs";
import {
  LOOKUP_TOOL,
  PATCH_TOOL
} from "../src/skill/stdio-effect-adapter.mjs";
import { RpcProcess } from "../src/testkit/rpc-process.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PROGRAM = join(HERE, "..", "src", "proxy", "effectgate.mjs");
const FIXTURE = join(
  HERE, "..", "src", "skill", "stdio-effect-fixture.mjs"
);
const NODE_DIGEST = reviewedFileDigest(process.execPath);
const FIXTURE_DIGEST = reviewedFileDigest(FIXTURE);

function configuration(root, sentinel) {
  return {
    schema_version: "1.0.0",
    driver: REVIEWED_STDIO_DRIVER,
    source: "reviewed",
    executable_path: process.execPath,
    executable_digest: NODE_DIGEST,
    argv: [
      FIXTURE,
      "--state", join(root, "backend.db"),
      "--target", "docs/guide.md"
    ],
    working_directory: root,
    source_files: [
      { path: FIXTURE, digest: FIXTURE_DIGEST },
      { path: sentinel, digest: reviewedFileDigest(sentinel) }
    ],
    server_identity: {
      name: "effectgate-reviewed-effect-fixture",
      version: EFFECTGATE_VERSION
    },
    catalog: { tools: [PATCH_TOOL, LOOKUP_TOOL] }
  };
}

test("reviewed stdio config admits only pinned safe reads and detects drift",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "effectgate-reviewed-backend-"));
    const sentinel = join(root, "reviewed-source.txt");
    const configFile = join(root, "effectgate.json");
    writeFileSync(sentinel, "reviewed source\n");
    writeFileSync(
      configFile,
      JSON.stringify(configuration(root, sentinel))
    );
    const loaded = loadReviewedBackendConfig(configFile);
    assert.equal(loaded.config.source, "reviewed");
    assert.ok(Object.isFrozen(loaded.config));

    const proxy = new RpcProcess([
      "mcp", "serve", "--config", configFile
    ], { timeoutMs: 15_000 });
    try {
      const initialized = await proxy.request("initialize", {
        protocolVersion: MCP_VERSION,
        capabilities: {},
        clientInfo: { name: "reviewed-backend-test", version: "1" }
      });
      assert.equal(initialized.result.protocolVersion, MCP_VERSION);
      assert.equal(initialized.result.capabilities.tools.listChanged, false);
      proxy.send({
        jsonrpc: "2.0",
        method: "notifications/initialized"
      });
      const listed = await proxy.request("tools/list");
      const names = listed.result.tools.map((tool) => tool.name);
      assert.ok(names.includes("reviewed__filesystem.patch.lookup"));
      assert.equal(
        names.includes("reviewed__filesystem.apply_patch"),
        false
      );
      assert.equal(
        (await proxy.request("tools/list", { cursor: "invented" }))
          .error.code,
        -32602
      );
      const lookup = await proxy.request("tools/call", {
        name: "reviewed__filesystem.patch.lookup",
        arguments: { idempotency_key: `eg_${"A".repeat(43)}` }
      });
      assert.equal(lookup.result.structuredContent.status, "not_found");
      assert.equal(
        (await proxy.request("tools/call", {
          name: "filesystem.apply_patch",
          arguments: {}
        })).error.code,
        -32602
      );

      writeFileSync(sentinel, "source drift\n");
      const drifted = await proxy.request("tools/call", {
        name: "reviewed__filesystem.patch.lookup",
        arguments: { idempotency_key: `eg_${"B".repeat(43)}` }
      });
      assert.equal(drifted.error.code, -32004);
      assert.doesNotMatch(JSON.stringify(drifted), /source drift/u);
    } finally {
      await proxy.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

test("unreviewed identities, catalogs, and mixed CLI selection fail closed",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "effectgate-reviewed-invalid-"));
    const sentinel = join(root, "reviewed-source.txt");
    const configFile = join(root, "effectgate.json");
    writeFileSync(sentinel, "reviewed source\n");
    const valid = configuration(root, sentinel);
    try {
      writeFileSync(configFile, JSON.stringify({
        ...valid,
        executable_digest: `sha256:${"0".repeat(64)}`
      }));
      assert.throws(
        () => loadReviewedBackendConfig(configFile),
        TypeError
      );
      writeFileSync(configFile, JSON.stringify({
        ...valid,
        server_identity: { name: "reviewed-backend", version: "" }
      }));
      assert.throws(
        () => loadReviewedBackendConfig(configFile),
        TypeError
      );
      writeFileSync(configFile, JSON.stringify({
        ...valid,
        catalog: { tools: [PATCH_TOOL] }
      }));
      assert.throws(
        () => loadReviewedBackendConfig(configFile),
        TypeError
      );
      writeFileSync(configFile, JSON.stringify(valid));
      const mixed = spawnSync(
        process.execPath,
        [
          PROGRAM, "mcp", "serve",
          "--source", "bypass", "--config", configFile
        ],
        { encoding: "utf8", windowsHide: true }
      );
      assert.equal(mixed.status, 2);
      assert.match(mixed.stderr, /Usage:/u);

      const changedLookup = {
        ...LOOKUP_TOOL,
        title: "Unreviewed catalog drift"
      };
      writeFileSync(configFile, JSON.stringify({
        ...valid,
        catalog: { tools: [PATCH_TOOL, changedLookup] }
      }));
      const drifted = new RpcProcess([
        "mcp", "serve", "--config", configFile
      ], { timeoutMs: 15_000 });
      try {
        await drifted.request("initialize", {
          protocolVersion: MCP_VERSION,
          capabilities: {},
          clientInfo: { name: "catalog-drift-test", version: "1" }
        });
        drifted.send({
          jsonrpc: "2.0",
          method: "notifications/initialized"
        });
        assert.equal(
          (await drifted.request("tools/list")).error.code,
          -32004
        );
      } finally {
        await drifted.stop();
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
