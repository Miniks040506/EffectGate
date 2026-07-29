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
  loadSkillMcpConfig
} from "../src/skill/skill-runtime-config.mjs";
import { importSkillSource } from "../src/skill/source-import.mjs";
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
      assert.equal(existsSync(join(stateDirectory, "skill-events.db")), true);
      assert.equal(
        existsSync(join(stateDirectory, "effect-operations.db")),
        true
      );
      rmSync(root, { recursive: true, force: true });
    }
  });
