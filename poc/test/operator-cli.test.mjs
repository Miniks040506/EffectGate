import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MCP_VERSION } from "../src/proxy/mcp-contract.mjs";
import { createConfiguredSkillMcp } from
  "../src/skill/skill-runtime-config.mjs";

const PROGRAM = fileURLToPath(
  new URL("../src/proxy/effectgate.mjs", import.meta.url)
);
const disclosureDigest = `sha256:${"a".repeat(64)}`;

function run(args) {
  return spawnSync(process.execPath, [PROGRAM, ...args], {
    encoding: "utf8",
    windowsHide: true
  });
}

function json(args, expectedStatus = 0) {
  const result = run([...args, "--json"]);
  assert.equal(result.status, expectedStatus, result.stderr);
  return JSON.parse(result.stdout);
}

test("operator CLI initializes, diagnoses, inspects, and fails closed",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "effectgate-operator-"));
    const skillRoot = join(root, "skill");
    const configFile = join(root, "config", "effectgate.json");
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
    const initArgs = [
      "init",
      "--config", configFile,
      "--state", stateDirectory,
      "--skill-root", skillRoot,
      "--target", "docs/guide.md",
      "--transaction", "operator-transaction"
    ];
    try {
      const dryRun = json([...initArgs, "--dry-run"]);
      assert.equal(dryRun.status, "dry_run");
      assert.equal(existsSync(configFile), false);
      assert.equal(existsSync(stateDirectory), false);

      const applied = json([...initArgs, "--apply"]);
      assert.equal(applied.status, "applied");
      assert.equal(existsSync(configFile), true);
      assert.equal(existsSync(stateDirectory), true);
      const originalConfig = readFileSync(configFile, "utf8");
      assert.equal(run([...initArgs, "--apply"]).status, 2);
      assert.equal(readFileSync(configFile, "utf8"), originalConfig);

      const firstDoctor = json(["doctor", "--config", configFile]);
      assert.equal(firstDoctor.status, "warn");
      assert.equal(
        firstDoctor.checks.find((check) => check.name === "backend").status,
        "pass"
      );
      assert.equal(
        firstDoctor.checks.find(
          (check) => check.name === "operation_database"
        ).status,
        "not_initialized"
      );
      assert.equal(
        existsSync(join(stateDirectory, "stdio-effect-backend.db")),
        false
      );
      assert.equal(
        json(["status", "--config", configFile]).status,
        "not_initialized"
      );

      const runtime = await createConfiguredSkillMcp(configFile);
      try {
        const initialized = await runtime.mcp.dispatch({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: MCP_VERSION,
            clientInfo: { name: "operator-test", version: "1.0.0" }
          }
        });
        assert.equal(initialized.result.protocolVersion, MCP_VERSION);
        await runtime.mcp.dispatch({
          jsonrpc: "2.0",
          method: "notifications/initialized",
          params: {}
        });
        const listed = await runtime.mcp.dispatch({
          jsonrpc: "2.0", id: 2, method: "tools/list", params: {}
        });
        const completed = await runtime.mcp.dispatch({
          jsonrpc: "2.0",
          id: 3,
          method: "tools/call",
          params: {
            name: listed.result.tools[0].name,
            arguments: {
              operation_id: "operator-operation",
              receipt_id: "operator-receipt",
              arguments: {
                path: "docs/guide.md",
                content: "OPERATOR_RAW_CONTENT_MUST_NOT_ESCAPE"
              },
              resource_scope: {
                kind: "exact",
                value: "repo:reviewed/path:docs/guide.md"
              },
              disclosure_digest: disclosureDigest
            }
          }
        });
        assert.equal(completed.result.isError, false);
      } finally {
        await runtime.close();
      }

      const current = json(["status", "--config", configFile]);
      assert.equal(current.status, "completed");
      assert.equal(current.receipt_count, 1);
      assert.equal(current.recovery_backlog, 0);
      assert.deepEqual(current.operations.map((operation) => ({
        id: operation.operation_id,
        state: operation.state,
        receipt: operation.receipt_id
      })), [{
        id: "operator-operation",
        state: "verified_committed",
        receipt: "operator-receipt"
      }]);
      assert.equal(
        JSON.stringify(current).includes(
          "OPERATOR_RAW_CONTENT_MUST_NOT_ESCAPE"
        ),
        false
      );

      const inspected = json([
        "receipt", "--config", configFile, "--id", "operator-receipt"
      ]);
      assert.equal(inspected.receipt.final_state, "verified_committed");
      assert.equal(inspected.receipt.transaction_id, "operator-transaction");
      assert.equal(
        JSON.stringify(inspected).includes(
          "OPERATOR_RAW_CONTENT_MUST_NOT_ESCAPE"
        ),
        false
      );
      assert.equal(run([
        "receipt", "--config", configFile, "--id", "missing-receipt"
      ]).status, 2);

      const finalDoctor = json(["doctor", "--config", configFile]);
      assert.equal(
        finalDoctor.checks.find(
          (check) => check.name === "operation_database"
        ).status,
        "pass"
      );
      writeFileSync(
        join(skillRoot, "SKILL.md"),
        "Drifted after configuration.\n"
      );
      const drifted = json(["doctor", "--config", configFile], 1);
      assert.equal(drifted.status, "fail");
      assert.equal(
        drifted.checks.find(
          (check) => check.name === "skill_source"
        ).status,
        "fail"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

test("operator CLI rejects ambiguous or incomplete commands", () => {
  assert.equal(run(["init", "--dry-run", "--apply"]).status, 2);
  assert.equal(run(["doctor", "--config", "x", "--config", "y"]).status, 2);
  assert.equal(run(["receipt", "--config", "x"]).status, 2);
  assert.equal(run(["unknown"]).status, 2);
});
