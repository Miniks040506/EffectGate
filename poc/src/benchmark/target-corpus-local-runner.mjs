#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  COMPACT_CALL_TOOL,
  COMPACT_DESCRIBE_TOOL,
  COMPACT_SEARCH_TOOL
} from "../proxy/compact-mux.mjs";
import {
  COMPACT_CONTEXT_PROJECT_TOOL,
  COMPACT_CONTEXT_SEARCH_TOOL,
  CONTEXT_PROJECT_TOOL,
  CONTEXT_SEARCH_TOOL,
  EFFECTGATE_VERSION,
  MCP_VERSION,
  TARGET_CORPUS_PAGE_BYTES,
  TARGET_CORPUS_PAGE_TOOL,
  TARGET_CORPUS_TOOL
} from "../proxy/effectgate.mjs";
import { canonicalJson, deepFreeze } from "../skill/passport-compiler.mjs";
import { RpcProcess } from "../testkit/rpc-process.mjs";
import { buildTargetCorpus } from "./target-corpus-fixture.mjs";

const COMMIT = /^[a-f0-9]{40}$/u;
const ROOT_CAUSE = "root_cause=database_pool_exhausted";
const PROFILES = Object.freeze([
  "P0_NATIVE_DEFAULT",
  "P1_EG_TYPED",
  "P2_EG_MUX",
  "P3_EAGER_DIAGNOSTIC"
]);
const USAGE =
  "Usage: target-corpus-local-runner.mjs --source-commit SHA --output FILE";

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function resultOf(response) {
  if (response?.error !== undefined || response?.result === undefined) {
    throw new Error("target corpus RPC failed");
  }
  return response.result;
}

function viewOf(response) {
  const result = resultOf(response);
  if (result.isError !== false || typeof result.content?.[0]?.text !== "string") {
    throw new Error("target corpus view failed");
  }
  return JSON.parse(result.content[0].text);
}

async function connect(args, profile) {
  const rpc = new RpcProcess(args, { timeoutMs: 30_000 });
  try {
    resultOf(await rpc.request("initialize", {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: {
        name: `effectgate-target-local-${profile}`,
        version: EFFECTGATE_VERSION
      }
    }));
    rpc.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return rpc;
  } catch (error) {
    await rpc.stop();
    throw error;
  }
}

function retrieval(taskId, artifactId) {
  if (taskId === "BENCH-READ-001") {
    return {
      tool: "search",
      arguments: {
        artifact_id: artifactId,
        query: ROOT_CAUSE,
        context_lines: 0,
        max_tokens: 512
      }
    };
  }
  if (taskId === "BENCH-JSON-002") {
    return {
      tool: "project",
      arguments: {
        artifact_id: artifactId,
        format: "json",
        fields: ["/id", "/customer_id",
          "/record/customer/account/profile/state/status"],
        filter: {
          pointer: "/record/customer/account/profile/state/status",
          equals: "rare_status"
        },
        limit: 1000,
        max_tokens: 512
      }
    };
  }
  if (taskId === "BENCH-STREAM-003") {
    return {
      tool: "project",
      arguments: {
        artifact_id: artifactId,
        format: "jsonl",
        fields: ["/id", "/status"],
        filter: { pointer: "/status", equals: "rare_status" },
        limit: 1000,
        max_tokens: 512
      }
    };
  }
  return {
    tool: "project",
    arguments: {
      artifact_id: artifactId,
      format: "csv",
      columns: ["id", "c01"],
      filter: { column: "c01", equals: "target_customer" },
      limit: 1000,
      max_tokens: 512
    }
  };
}

function oracle(taskId, view) {
  if (taskId === "BENCH-READ-001") return view.content.includes(ROOT_CAUSE);
  const records = view.content.trimEnd().split("\n").filter(Boolean)
    .map(JSON.parse);
  if (taskId === "BENCH-JSON-002") {
    return records.length === 1 && records[0]["/id"] === 42_424 &&
      records[0]["/customer_id"] === "customer-target-42424";
  }
  if (taskId === "BENCH-STREAM-003") {
    return records.length === 1 && records[0]["/id"] === 77_777 &&
      view.diagnostics.filter(
        ({ code }) => code === "EG-PROJECT-JSONL-001"
      ).length === 3;
  }
  return records.length === 1 && records[0].id === "42424" &&
    records[0].c01 === "target_customer";
}

async function directCells(profile, datasets) {
  const rpc = await connect(["target-corpus-fixture"], profile);
  try {
    const catalog = resultOf(await rpc.request("tools/list"));
    const catalogValid = canonicalJson(catalog.tools) === canonicalJson([
      TARGET_CORPUS_TOOL,
      TARGET_CORPUS_PAGE_TOOL
    ]);
    const cells = [];
    for (const dataset of datasets) {
      const expected = Buffer.from(dataset.text, "utf8");
      const sourceDigest = digest(expected);
      let offset = 0;
      let exactBytes = true;
      let digestBound = true;
      let boundedPages = true;
      let coveredBytes = 0;
      do {
        const page = viewOf(await rpc.request("tools/call", {
          name: TARGET_CORPUS_PAGE_TOOL.name,
          arguments: {
            task_id: dataset.task_id,
            offset,
            max_bytes: TARGET_CORPUS_PAGE_BYTES
          }
        }));
        const content = Buffer.from(page.content, "utf8");
        exactBytes &&= page.byte_start === offset &&
          page.byte_end === offset + content.length &&
          expected.subarray(offset, page.byte_end).equals(content);
        digestBound &&= page.source_digest === sourceDigest &&
          page.total_bytes === expected.length;
        boundedPages &&= content.length <= TARGET_CORPUS_PAGE_BYTES;
        exactBytes &&= page.next_offset === null
          ? page.byte_end === expected.length
          : page.next_offset === page.byte_end && page.next_offset > offset;
        coveredBytes = page.byte_end;
        offset = page.next_offset;
      } while (offset !== null);
      exactBytes &&= coveredBytes === expected.length;
      const checks = {
        bounded_standard_pages: boundedPages,
        exact_corpus_bytes: exactBytes,
        frozen_source_digest: digestBound,
        standard_catalog: catalogValid
      };
      cells.push({
        profile,
        task_id: dataset.task_id,
        transport: "standard_mcp_pages",
        source_digest: sourceDigest,
        checks,
        verdict: Object.values(checks).every(Boolean) ? "pass" : "fail"
      });
    }
    if (rpc.stderr !== "") throw new Error("target corpus fixture stderr");
    return cells;
  } finally {
    await rpc.stop();
  }
}

async function effectGateCells(profile, datasets) {
  const compact = profile === "P2_EG_MUX";
  const rpc = await connect([
    "mcp", "serve", "--source", "target-corpus", "--profile",
    compact ? "compact_mux" : "native_deferred"
  ], profile);
  try {
    const catalog = resultOf(await rpc.request("tools/list"));
    let ref;
    let catalogValid = true;
    if (compact) {
      const found = viewOf(await rpc.request("tools/call", {
        name: COMPACT_SEARCH_TOOL.name,
        arguments: { query: "frozen target corpus" }
      }));
      ref = found.matches.find(
        ({ ref: value }) => value.endsWith(`__${TARGET_CORPUS_TOOL.name}`)
      )?.ref;
      const described = viewOf(await rpc.request("tools/call", {
        name: COMPACT_DESCRIBE_TOOL.name,
        arguments: { ref }
      }));
      catalogValid = canonicalJson(described.input_schema) ===
        canonicalJson(TARGET_CORPUS_TOOL.inputSchema);
    } else {
      ref = catalog.tools.find(
        ({ name }) => name.endsWith(`__${TARGET_CORPUS_TOOL.name}`)
      )?.name;
      catalogValid = typeof ref === "string";
    }
    const cells = [];
    for (const dataset of datasets) {
      const first = viewOf(await rpc.request("tools/call", compact ? {
        name: COMPACT_CALL_TOOL.name,
        arguments: { ref, arguments: { task_id: dataset.task_id } }
      } : {
        name: ref,
        arguments: { task_id: dataset.task_id }
      }));
      const operation = retrieval(dataset.task_id, first.artifact_id);
      const retrieved = viewOf(await rpc.request("tools/call", {
        name: operation.tool === "search"
          ? compact
            ? COMPACT_CONTEXT_SEARCH_TOOL.name
            : CONTEXT_SEARCH_TOOL.name
          : compact
            ? COMPACT_CONTEXT_PROJECT_TOOL.name
            : CONTEXT_PROJECT_TOOL.name,
        arguments: operation.arguments
      }));
      const checks = {
        bounded_first_view: first.status === "partial_view",
        frozen_source_digest:
          first.integrity?.artifact_digest === digest(dataset.text),
        retrieval_oracle: oracle(dataset.task_id, retrieved),
        tool_contract: catalogValid
      };
      cells.push({
        profile,
        task_id: dataset.task_id,
        transport: compact ? "compact_context_view" : "typed_context_view",
        source_digest: digest(dataset.text),
        checks,
        verdict: Object.values(checks).every(Boolean) ? "pass" : "fail"
      });
    }
    if (rpc.stderr !== "") throw new Error("target corpus proxy stderr");
    return cells;
  } finally {
    await rpc.stop();
  }
}

export async function runTargetCorpusLocalQualification({ sourceCommit } = {}) {
  if (!COMMIT.test(sourceCommit ?? "")) {
    throw new TypeError("target corpus local report requires a full commit");
  }
  const datasets = buildTargetCorpus();
  const cells = [];
  for (const profile of PROFILES) {
    cells.push(...(profile === "P1_EG_TYPED" || profile === "P2_EG_MUX"
      ? await effectGateCells(profile, datasets)
      : await directCells(profile, datasets)));
  }
  const checks = {
    all_cells_pass: cells.every(({ verdict }) => verdict === "pass"),
    complete_matrix: cells.length === PROFILES.length * datasets.length,
    no_model_execution: true
  };
  return deepFreeze({
    kind: "effectgate_target_corpus_local_qualification",
    schema_version: "1.0.0",
    source_commit: sourceCommit,
    scope: "local_transport_retrieval",
    release_gate_eligible: false,
    profiles: PROFILES,
    tasks: datasets.map(({ task_id }) => task_id),
    cells,
    checks,
    limitations: [
      "no_model_execution",
      "no_host_token_measurement",
      "no_task_quality_measurement"
    ],
    verdict: Object.values(checks).every(Boolean) ? "pass" : "fail"
  });
}

export async function writeTargetCorpusLocalQualification({
  sourceCommit,
  output
} = {}) {
  if (typeof output !== "string" || output.length < 1 ||
      output.length > 1024 || output.includes("\0")) {
    throw new TypeError("invalid target corpus local report output");
  }
  const report = await runTargetCorpusLocalQualification({ sourceCommit });
  const file = resolve(output);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  writeFileSync(file, `${canonicalJson(report)}\n`, {
    flag: "wx",
    encoding: "utf8",
    mode: 0o600,
    flush: true
  });
  return deepFreeze({ file, report });
}

function parseArguments(args) {
  if (args.length !== 4) throw new Error(USAGE);
  const values = Object.fromEntries([[args[0], args[1]], [args[2], args[3]]]);
  if (Object.keys(values).length !== 2 ||
      values["--source-commit"] === undefined ||
      values["--output"] === undefined) {
    throw new Error(USAGE);
  }
  return { sourceCommit: values["--source-commit"], output: values["--output"] };
}

export async function main(args = process.argv.slice(2)) {
  const result = await writeTargetCorpusLocalQualification(parseArguments(args));
  process.stdout.write(`${JSON.stringify({
    report_file: result.file,
    cells: result.report.cells.length,
    verdict: result.report.verdict,
    release_gate_eligible: result.report.release_gate_eligible
  })}\n`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`[effectgate-target-local] ${error.message}\n`);
    process.exitCode = 2;
  });
}
