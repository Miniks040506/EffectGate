import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { MCP_VERSION } from "../src/proxy/mcp-contract.mjs";
import { compileEffectIntent } from "../src/policy/effect-intent.mjs";
import { EffectOperationJournal } from
  "../src/policy/operation-journal.mjs";
import { createConfiguredSkillMcp } from
  "../src/skill/skill-runtime-config.mjs";

const PROGRAM = fileURLToPath(
  new URL("../src/proxy/effectgate.mjs", import.meta.url)
);
const disclosureDigest = `sha256:${"a".repeat(64)}`;
const digest = (character) => `sha256:${character.repeat(64)}`;

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

function jsonLive(args, expectedStatus = 0) {
  return new Promise((accept, reject) => {
    const child = spawn(process.execPath, [PROGRAM, ...args, "--json"], {
      windowsHide: true
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", reject);
    child.once("exit", (status) => {
      try {
        assert.equal(status, expectedStatus, stderr);
        accept(stdout.length > 0 ? JSON.parse(stdout) : null);
      } catch (error) {
        reject(error);
      }
    });
  });
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
      assert.equal(firstDoctor.status, "pass");
      assert.deepEqual(
        firstDoctor.configuration_layers,
        [realpathSync(configFile)]
      );
      assert.equal(
        firstDoctor.checks.find(
          (check) => check.name === "secret_references"
        ).status,
        "pass"
      );
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
        const call = (operationId, receiptId, content, id) =>
          runtime.mcp.dispatch({
            jsonrpc: "2.0",
            id,
            method: "tools/call",
            params: {
              name: listed.result.tools[0].name,
              arguments: {
                operation_id: operationId,
                receipt_id: receiptId,
                arguments: { path: "docs/guide.md", content },
                resource_scope: {
                  kind: "exact",
                  value: "repo:reviewed/path:docs/guide.md"
                },
                disclosure_digest: disclosureDigest
              }
            }
          });
        const deniedPending = await call(
          "operator-denied",
          "operator-denied-receipt",
          "DENIED_CONTENT_MUST_NOT_RUN",
          3
        );
        assert.equal(
          deniedPending.result.structuredContent.status,
          "awaiting_approval"
        );
        const deniedCard = await jsonLive([
          "approve", "--config", configFile,
          "--operation", "operator-denied"
        ]);
        assert.equal(deniedCard.status, "confirmation_required");
        assert.equal(deniedCard.approval.effect_class, "mutate_reversible");
        assert.equal(
          JSON.stringify(deniedCard).includes("DENIED_CONTENT_MUST_NOT_RUN"),
          true
        );
        const denied = await jsonLive([
          "approve", "--config", configFile,
          "--operation", "operator-denied", "--deny"
        ]);
        assert.equal(denied.status, "denied");
        assert.equal(
          (await call(
            "operator-denied",
            "operator-denied-receipt",
            "DENIED_CONTENT_MUST_NOT_RUN",
            4
          )).result.isError,
          true
        );

        const approvedArguments = [
          "approve", "--config", configFile,
          "--operation", "operator-operation"
        ];
        const pending = await call(
          "operator-operation",
          "operator-receipt",
          "OPERATOR_RAW_CONTENT_MUST_NOT_ESCAPE",
          5
        );
        assert.equal(
          pending.result.structuredContent.status,
          "awaiting_approval"
        );
        assert.equal(
          JSON.stringify(pending).includes(
            "OPERATOR_RAW_CONTENT_MUST_NOT_ESCAPE"
          ),
          false
        );
        const card = await jsonLive(approvedArguments);
        assert.equal(card.status, "confirmation_required");
        assert.deepEqual(card.approval.exact_arguments, {
          path: "docs/guide.md",
          content: "OPERATOR_RAW_CONTENT_MUST_NOT_ESCAPE"
        });
        assert.equal(
          readdirSync(stateDirectory)
            .filter((file) => file.endsWith(".db"))
            .some((file) => readFileSync(
              join(stateDirectory, file)
            ).includes("OPERATOR_RAW_CONTENT_MUST_NOT_ESCAPE")),
          false
        );
        await jsonLive([
          ...approvedArguments,
          "--approver", "operator-test",
          "--intent", digest("f"),
          "--yes"
        ], 2);
        const approved = await jsonLive([
          ...approvedArguments,
          "--approver", "operator-test",
          "--intent", card.approval.intent_digest,
          "--yes"
        ]);
        assert.equal(approved.status, "approved");
        assert.equal(approved.state, "admitted");
        assert.equal(JSON.stringify(approved).includes("egl_"), false);
        await jsonLive([
          ...approvedArguments,
          "--approver", "operator-test",
          "--intent", card.approval.intent_digest,
          "--yes"
        ], 2);
        await jsonLive([
          "resolve", "--config", configFile,
          "--operation", "missing-operation", "--reconcile"
        ], 2);
        assert.equal(
          (await call(
            "operator-operation",
            "operator-receipt",
            "CHANGED_AFTER_APPROVAL_MUST_NOT_RUN",
            6
          )).result.isError,
          true
        );

        const completed = await call(
          "operator-operation",
          "operator-receipt",
          "OPERATOR_RAW_CONTENT_MUST_NOT_ESCAPE",
          7
        );
        assert.equal(completed.result.isError, false);
        assert.equal(
          completed.result.structuredContent.status,
          "completed"
        );
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
      })), [
        {
          id: "operator-denied",
          state: "abandoned",
          receipt: null
        },
        {
          id: "operator-operation",
          state: "verified_committed",
          receipt: "operator-receipt"
        }
      ]);
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

      const config = JSON.parse(readFileSync(configFile, "utf8"));
      const now = Date.now();
      const journal = new EffectOperationJournal({
        file: join(stateDirectory, "effect-operations.db")
      });
      const manualIntent = compileEffectIntent({
        principalId: "local-operator",
        clientId: "local-mcp-client",
        sessionId: config.transaction_id,
        admission: {
          schema_version: "1.0.0",
          transaction_id: config.transaction_id,
          skill_id: "document-editor",
          skill_digest: config.skill_source_digest,
          phase: "modify",
          phase_revision: 1,
          capsule_digest: digest("b"),
          capability_id: "filesystem.apply_patch",
          capability_revision: "patch-v1",
          effect_class: "mutate_reversible"
        },
        policyDecision: {
          decision: "allow",
          policy_revision: digest("c"),
          matched_rule_ids: ["manual-fixture"],
          safe_reason_code: "policy_allow"
        },
        arguments: { path: "docs/guide.md", content: "AMBIGUOUS_CONTENT" },
        resourceScope: {
          kind: "exact",
          value: "repo:reviewed/path:docs/guide.md"
        },
        disclosureDigest: digest("d"),
        expiresAt: new Date(now + 300_000).toISOString(),
        now: () => now
      });
      try {
        journal.plan({
          operationId: "operator-manual",
          intent: manualIntent,
          approvalRequired: false
        });
        journal.preflight("operator-manual");
        journal.admit("operator-manual");
        journal.beginDispatch({
          operationId: "operator-manual",
          dispatchDigest: digest("e"),
          deadlineAt: new Date(now + 60_000).toISOString()
        });
        journal.markUncertain({
          operationId: "operator-manual",
          evidenceRef: digest("f"),
          reason: "response_lost_after_dispatch"
        });
      } finally {
        journal.close();
      }
      const resolution = json([
        "resolve", "--config", configFile,
        "--operation", "operator-manual"
      ]);
      assert.equal(resolution.status, "confirmation_required");
      const note = "OPERATOR_PRIVATE_RESOLUTION_NOTE";
      const resolved = json([
        "resolve", "--config", configFile,
        "--operation", "operator-manual",
        "--manual", "--receipt", "operator-manual-receipt",
        "--note", note, "--yes"
      ]);
      assert.equal(resolved.status, "manual_resolution");
      assert.equal(resolved.receipt_id, "operator-manual-receipt");
      assert.match(resolved.note_digest, /^sha256:[a-f0-9]{64}$/u);
      assert.equal(JSON.stringify(resolved).includes(note), false);
      assert.equal(
        readdirSync(stateDirectory).some((file) =>
          readFileSync(join(stateDirectory, file)).includes(note)),
        false
      );
      assert.equal(json([
        "receipt", "--config", configFile,
        "--id", "operator-manual-receipt"
      ]).receipt.final_state, "manual_resolution");

      const finalDoctor = json(["doctor", "--config", configFile]);
      assert.equal(
        finalDoctor.checks.find(
          (check) => check.name === "operation_database"
        ).status,
        "pass"
      );
      assert.equal(finalDoctor.status, "warn");
      assert.equal(
        finalDoctor.checks.find(
          (check) => check.name === "recovery_backlog"
        ).detail,
        1
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
  assert.equal(run([
    "approve", "--config", "x", "--operation", "op", "--yes"
  ]).status, 2);
  assert.equal(run([
    "resolve", "--config", "x", "--operation", "op", "--manual", "--yes"
  ]).status, 2);
  assert.equal(run([
    "resolve", "--config", "x", "--operation", "op",
    "--reconcile", "--manual"
  ]).status, 2);
  assert.equal(run(["unknown"]).status, 2);
});
