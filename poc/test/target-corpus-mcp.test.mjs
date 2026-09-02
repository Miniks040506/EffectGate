import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildTargetDataset } from
  "../src/benchmark/target-corpus-fixture.mjs";
import { writeTargetCorpusLocalQualification } from
  "../src/benchmark/target-corpus-local-runner.mjs";
import {
  MCP_VERSION,
  TARGET_CORPUS_PAGE_TOOL,
  TARGET_CORPUS_TOOL
} from "../src/proxy/effectgate.mjs";
import { canonicalJson } from "../src/skill/passport-compiler.mjs";
import { RpcProcess } from "../src/testkit/rpc-process.mjs";

const SOURCE_COMMIT = "a".repeat(40);

async function connect(context) {
  const rpc = new RpcProcess(["target-corpus-fixture"], { timeoutMs: 30_000 });
  context.after(() => rpc.stop());
  const initialized = await rpc.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "target-invalid", version: "1" }
  });
  assert.equal(initialized.error, undefined);
  rpc.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return rpc;
}

async function connectProxy(context) {
  const rpc = new RpcProcess([
    "mcp",
    "serve",
    "--source",
    "target-corpus",
    "--profile",
    "native_deferred"
  ], { timeoutMs: 30_000 });
  context.after(() => rpc.stop());
  const initialized = await rpc.request("initialize", {
    protocolVersion: MCP_VERSION,
    capabilities: {},
    clientInfo: { name: "target-proxy", version: "1" }
  });
  assert.equal(initialized.error, undefined);
  rpc.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  return rpc;
}

test("local target report seals all sixteen transport cells", async () => {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-target-local-"));
  const output = join(directory, "qualification.json");
  try {
    const { file, report } = await writeTargetCorpusLocalQualification({
      sourceCommit: SOURCE_COMMIT,
      output
    });
    assert.equal(file, output);
    assert.equal(report.verdict, "pass");
    assert.equal(report.release_gate_eligible, false);
    assert.equal(report.cells.length, 16);
    assert.equal(new Set(report.cells.map(
      ({ profile, task_id }) => `${profile}:${task_id}`
    )).size, 16);
    assert.equal(report.cells.every(({ verdict }) => verdict === "pass"), true);
    assert.equal(report.cells.filter(
      ({ transport }) => transport === "standard_mcp_pages"
    ).length, 8);
    assert.deepEqual(report.limitations, [
      "no_model_execution",
      "no_host_token_measurement",
      "no_task_quality_measurement"
    ]);
    assert.equal(readFileSync(output, "utf8"), `${canonicalJson(report)}\n`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("target corpus MCP rejects invalid tasks and UTF-8 offsets", async (context) => {
  const rpc = await connect(context);
  const listed = await rpc.request("tools/list");
  assert.deepEqual(listed.result.tools,
    [TARGET_CORPUS_TOOL, TARGET_CORPUS_PAGE_TOOL]);
  const unknown = await rpc.request("tools/call", {
    name: TARGET_CORPUS_TOOL.name,
    arguments: { task_id: "BENCH-UNKNOWN-999" }
  });
  assert.equal(unknown.error.code, -32602);
  const csv = Buffer.from(buildTargetDataset("BENCH-TABLE-004").text);
  const unicode = csv.indexOf(Buffer.from("ệ"));
  const splitUtf8 = await rpc.request("tools/call", {
    name: TARGET_CORPUS_PAGE_TOOL.name,
    arguments: { task_id: "BENCH-TABLE-004", offset: unicode + 1 }
  });
  assert.equal(splitUtf8.error.code, -32602);
  assert.deepEqual((await rpc.request("ping")).result, {});
});

test("proxied target corpus advertises and completes the artifact bootstrap", async (context) => {
  const rpc = await connectProxy(context);
  const listed = await rpc.request("tools/list");
  const bootstrap = listed.result.tools.find(
    ({ name }) => name === "target-corpus__target_corpus"
  );
  assert.ok(bootstrap);
  assert.match(bootstrap.description, /EffectGate-routed backend tool/u);
  assert.match(bootstrap.description, /bounded Context View/u);
  assert.match(bootstrap.description, /artifact_id/u);

  const opened = await rpc.request("tools/call", {
    name: bootstrap.name,
    arguments: { task_id: "BENCH-READ-001" }
  });
  const view = JSON.parse(opened.result.content[0].text);
  assert.match(view.artifact_id, /^art_[a-f0-9]{64}$/u);

  const searched = await rpc.request("tools/call", {
    name: "effectgate_search",
    arguments: {
      artifact_id: view.artifact_id,
      query: "root_cause=database_pool_exhausted",
      context_lines: 0,
      max_tokens: 256
    }
  });
  const result = JSON.parse(searched.result.content[0].text);
  assert.match(result.content, /root_cause=database_pool_exhausted/u);
  assert.ok(result.citations.length > 0);
});

test("local target report rejects an unbound source", async () => {
  await assert.rejects(
    writeTargetCorpusLocalQualification({
      sourceCommit: "not-a-commit",
      output: "unused.json"
    }),
    /full commit/u
  );
});
