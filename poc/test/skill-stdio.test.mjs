import assert from "node:assert/strict";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { MCP_VERSION } from "../src/proxy/mcp-contract.mjs";
import {
  createConfiguredSkillMcp,
  loadSkillMcpConfig
} from "../src/skill/skill-runtime-config.mjs";
import { importSkillSource } from "../src/skill/source-import.mjs";
import {
  STDIO_EFFECT_DRIVER,
  createReviewedStdioEffectBackend,
  stdioEffectAdapterSourceDigest
} from "../src/skill/stdio-effect-adapter.mjs";
import { RpcProcess } from "../src/testkit/rpc-process.mjs";

const digest = (character) => `sha256:${character.repeat(64)}`;

test("reviewed configuration serves one bound verified-effect MCP tool",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "effectgate-skill-stdio-"));
    const skillRoot = join(root, "skill");
    const stateDirectory = join(root, "state");
    mkdirSync(join(skillRoot, "phases"), { recursive: true });
    writeFileSync(
      join(skillRoot, "SKILL.md"),
      "Preserve the original until verification.\n"
    );
    writeFileSync(
      join(skillRoot, "phases", "modify.md"),
      "Apply only the reviewed patch.\n"
    );
    const source = importSkillSource({
      root: skillRoot,
      paths: ["SKILL.md", "phases/modify.md"]
    });
    const config = {
      schema_version: "1.0.0",
      driver: "effectgate.fixture.memory-patch.v1",
      state_directory: stateDirectory,
      skill_root: skillRoot,
      skill_source_digest: source.source_digest,
      transaction_id: "configured-transaction",
      principal_id: "principal-local",
      client_id: "effectgate-stdio-test",
      target_path: "docs/guide.md",
      resource_scope: "repo:fixture/path:docs/guide.md"
    };
    const configFile = join(root, "effectgate.json");
    writeFileSync(configFile, JSON.stringify(config));
    const invalidFile = join(root, "invalid.json");
    writeFileSync(invalidFile, JSON.stringify({
      ...config,
      driver: "arbitrary.module.or.command"
    }));
    assert.throws(() => loadSkillMcpConfig(invalidFile), TypeError);
    assert.ok(Object.isFrozen(loadSkillMcpConfig(configFile)));

    const server = new RpcProcess([
      "mcp", "skill", "serve", "--config", configFile
    ]);
    try {
      assert.equal(
        (await server.request("tools/list")).error.code,
        -32007
      );
      const initialized = await server.request("initialize", {
        protocolVersion: MCP_VERSION,
        clientInfo: { name: "effectgate-test", version: "1.0.0" }
      });
      assert.equal(initialized.result.protocolVersion, MCP_VERSION);
      server.send({
        jsonrpc: "2.0",
        method: "notifications/initialized",
        params: {}
      });
      const listed = await server.request("tools/list");
      assert.equal(listed.result.tools.length, 1);
      const tool = listed.result.tools[0];
      assert.equal(tool.name, "effectgate_apply_verified_patch");
      const contract = JSON.stringify(tool.inputSchema);
      assert.equal(contract.includes("transaction_id"), false);
      assert.equal(contract.includes("capsule_digest"), false);
      assert.equal(contract.includes("capability_revision"), false);

      const denied = await server.request("tools/call", {
        name: tool.name,
        arguments: {
          operation_id: "configured-denied",
          receipt_id: "configured-denied-receipt",
          arguments: { path: "outside.txt", content: "MUST_NOT_ESCAPE" },
          resource_scope: {
            kind: "exact",
            value: config.resource_scope
          },
          disclosure_digest: digest("a")
        }
      });
      assert.equal(denied.result.isError, true);
      assert.equal(
        JSON.stringify(denied).includes("MUST_NOT_ESCAPE"),
        false
      );

      const completed = await server.request("tools/call", {
        name: tool.name,
        arguments: {
          operation_id: "configured-operation",
          receipt_id: "configured-receipt",
          arguments: {
            path: config.target_path,
            content: "MUST_NOT_ESCAPE_VERIFIED_WRITE"
          },
          resource_scope: {
            kind: "exact",
            value: config.resource_scope
          },
          disclosure_digest: digest("b")
        }
      });
      assert.equal(completed.result.isError, false);
      assert.equal(
        completed.result.structuredContent.effect_receipt.final_state,
        "verified_committed"
      );
      assert.equal(
        JSON.stringify(completed).includes(
          "MUST_NOT_ESCAPE_VERIFIED_WRITE"
        ),
        false
      );
      assert.equal(
        completed.result.structuredContent.phase_receipt.next_phase,
        null
      );
    } finally {
      await server.stop();
      const restarted = new RpcProcess([
        "mcp", "skill", "serve", "--config", configFile
      ]);
      try {
        await restarted.request("initialize", {
          protocolVersion: MCP_VERSION,
          clientInfo: { name: "effectgate-restart-test", version: "1.0.0" }
        });
        restarted.send({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {}
        });
        assert.equal(
          (await restarted.request("tools/list")).result.tools.length,
          0
        );
      } finally {
        await restarted.stop();
        assert.equal(
          existsSync(join(stateDirectory, "skill-events.db")),
          true
        );
        assert.equal(
          existsSync(join(stateDirectory, "effect-operations.db")),
          true
        );
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

test("reviewed stdio effect backend is pinned and survives response loss",
  async () => {
    for (const [name, content] of [
      ["crash", "EFFECTGATE_FIXTURE_CRASH_AFTER_COMMIT"],
      ["timeout", "EFFECTGATE_FIXTURE_TIMEOUT_BEFORE_RESPONSE"]
    ]) {
      const root = mkdtempSync(
        join(tmpdir(), `effectgate-stdio-effect-${name}-`)
      );
      const skillRoot = join(root, "skill");
      const stateDirectory = join(root, "state");
      mkdirSync(join(skillRoot, "phases"), { recursive: true });
      writeFileSync(
        join(skillRoot, "SKILL.md"),
        "Preserve the original until verification.\n"
      );
      writeFileSync(
        join(skillRoot, "phases", "modify.md"),
        "Apply only the reviewed patch.\n"
      );
      const source = importSkillSource({
        root: skillRoot,
        paths: ["SKILL.md", "phases/modify.md"]
      });
      const config = {
        schema_version: "1.0.0",
        driver: STDIO_EFFECT_DRIVER,
        state_directory: stateDirectory,
        skill_root: skillRoot,
        skill_source_digest: source.source_digest,
        transaction_id: `stdio-effect-${name}`,
        principal_id: "principal-local",
        client_id: "effectgate-stdio-effect-test",
        target_path: "docs/guide.md",
        resource_scope: "repo:fixture/path:docs/guide.md",
        backend_source_digest: stdioEffectAdapterSourceDigest()
      };
      const configFile = join(root, "effectgate.json");
      writeFileSync(configFile, JSON.stringify(config));
      if (name === "crash") {
        const mismatchedFile = join(root, "mismatched.json");
        writeFileSync(mismatchedFile, JSON.stringify({
          ...config,
          backend_source_digest: digest("f")
        }));
        await assert.rejects(
          createConfiguredSkillMcp(mismatchedFile),
          TypeError
        );
      }
      const server = new RpcProcess([
        "mcp", "skill", "serve", "--config", configFile
      ]);
      try {
        await server.request("initialize", {
          protocolVersion: MCP_VERSION,
          clientInfo: {
            name: "effectgate-stdio-effect-test",
            version: "1.0.0"
          }
        });
        server.send({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {}
        });
        const listed = await server.request("tools/list");
        assert.equal(listed.result.tools.length, 1);
        const completed = await server.request("tools/call", {
          name: listed.result.tools[0].name,
          arguments: {
            operation_id: `stdio-operation-${name}`,
            receipt_id: `stdio-receipt-${name}`,
            arguments: { path: config.target_path, content },
            resource_scope: {
              kind: "exact",
              value: config.resource_scope
            },
            disclosure_digest: digest("a")
          }
        });
        assert.equal(completed.result.isError, false);
        assert.equal(
          completed.result.structuredContent.effect_receipt.final_state,
          "verified_committed"
        );
        assert.equal(
          JSON.stringify(completed).includes(content),
          false
        );
      } finally {
        await server.stop();
      }
      const restarted = new RpcProcess([
        "mcp", "skill", "serve", "--config", configFile
      ]);
      try {
        await restarted.request("initialize", {
          protocolVersion: MCP_VERSION,
          clientInfo: {
            name: "effectgate-stdio-effect-restart",
            version: "1.0.0"
          }
        });
        restarted.send({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {}
        });
        assert.equal(
          (await restarted.request("tools/list")).result.tools.length,
          0
        );
        assert.equal(
          existsSync(join(stateDirectory, "stdio-effect-backend.db")),
          true
        );
      } finally {
        await restarted.stop();
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

test("reviewed stdio effect adapter deduplicates and rejects intent drift",
  async () => {
    const root = mkdtempSync(
      join(tmpdir(), "effectgate-stdio-effect-idempotency-")
    );
    const configuration = {
      stateFile: join(root, "backend.db"),
      targetPath: "docs/guide.md",
      cwd: root,
      expectedSourceDigest: stdioEffectAdapterSourceDigest()
    };
    const idempotencyKey = `eg_${"A".repeat(43)}`;
    let backend = await createReviewedStdioEffectBackend(configuration);
    try {
      await Promise.all([
        backend.apply({
          path: configuration.targetPath,
          content: "same reviewed intent",
          idempotencyKey
        }),
        backend.apply({
          path: configuration.targetPath,
          content: "same reviewed intent",
          idempotencyKey
        })
      ]);
      assert.equal(await backend.lookup(idempotencyKey), "found");
      await assert.rejects(backend.apply({
        path: configuration.targetPath,
        content: "different intent",
        idempotencyKey
      }));
      await backend.close();
      backend = await createReviewedStdioEffectBackend(configuration);
      assert.equal(await backend.lookup(idempotencyKey), "found");
    } finally {
      await backend.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
