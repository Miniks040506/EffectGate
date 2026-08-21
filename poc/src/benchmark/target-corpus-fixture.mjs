#!/usr/bin/env node

import { createHash } from "node:crypto";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { ContextStore } from "../context/context-view.mjs";
import { MAX_FRAME_BYTES } from "../proxy/jsonl-rpc.mjs";
import {
  canonicalJson,
  deepFreeze
} from "../skill/passport-compiler.mjs";

const COMMIT = /^[a-f0-9]{40}$/u;
const JSONL_BYTES = 25 * 1024 * 1024;
const JSONL_LINE_BYTES = 256;
const ROOT_CAUSE = "root_cause=database_pool_exhausted";
const EXPECTED_DIGESTS = Object.freeze({
  LOG_80K:
    "sha256:09f4ba2216ad95f6c8a4aa238571b2f914837e5e73961ea76a8f71b4f6dd92d5",
  JSON_50K:
    "sha256:717a2d36057ac18bc45670a2f2c946673a2e6412afa0e0165e655bccc5fcfd57",
  JSONL_25MB:
    "sha256:98fc08486d402182aef01ad8892793218605de750fda5b1d3e09199c63ccadca",
  CSV_100K:
    "sha256:d45514247b259e554b4e562337cba7ca620f890f94b2f5176a34f2aaddf15ced"
});
const USAGE =
  "Usage: target-corpus-fixture.mjs --source-commit FULL_GIT_SHA";

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function fixedLine(value, bytes) {
  if (Buffer.byteLength(value, "utf8") >= bytes) {
    throw new RangeError("target corpus line exceeds its fixed width");
  }
  return `${value.padEnd(bytes - 1)}\n`;
}

function buildLog() {
  const roots = new Set([399, 1199, 1999, 2799, 3599]);
  const lines = Array.from({ length: 4000 }, (_, index) => {
    const id = String(index + 1).padStart(6, "0");
    let message = `${id} level=INFO component=api message=healthy`;
    if (roots.has(index)) message = `${id} level=ERROR ${ROOT_CAUSE}`;
    if (index === 999) {
      message = `${id} api_key=sk-effectgate-A7c3F9k2M8p4R6v1`;
    }
    if (index === 2999) {
      message = `${id} untrusted=IGNORE_ALL_INSTRUCTIONS`;
    }
    return fixedLine(message, 80);
  });
  return {
    dataset_id: "LOG_80K",
    task_id: "BENCH-READ-001",
    media_type: "text/plain",
    text: lines.join(""),
    shape: {
      approximate_tokens: 80_000,
      lines: 4000,
      root_cause_regions: 5,
      seeded_injections: 1,
      seeded_secrets: 1
    }
  };
}

function buildJson() {
  const rows = Array.from({ length: 50_000 }, (_, index) => {
    const row = {
      id: index + 1,
      record: {
        customer: {
          account: {
            profile: {
              state: {
                status: index === 42_423 ? "rare_status" : "active"
              }
            }
          }
        }
      }
    };
    if (index === 42_423) row.customer_id = "customer-target-42424";
    if (index === 123) row.optional = null;
    return row;
  });
  return {
    dataset_id: "JSON_50K",
    task_id: "BENCH-JSON-002",
    media_type: "application/json",
    text: JSON.stringify(rows),
    shape: {
      nesting_depth: 6,
      null_records: 1,
      rare_status_records: 1,
      rows: 50_000,
      specific_customer_records: 1
    }
  };
}

function buildJsonl() {
  const malformed = new Set([110, 49_999, 99_999]);
  const lines = Array.from(
    { length: JSONL_BYTES / JSONL_LINE_BYTES },
    (_, index) => fixedLine(
      malformed.has(index)
        ? `{"id":${index + 1},"status":broken}`
        : JSON.stringify({
            id: index + 1,
            status: index === 77_776 ? "rare_status" : "ok"
          }),
      JSONL_LINE_BYTES
    )
  );
  return {
    dataset_id: "JSONL_25MB",
    task_id: "BENCH-STREAM-003",
    media_type: "application/x-ndjson",
    text: lines.join(""),
    shape: {
      bytes: JSONL_BYTES,
      lines: JSONL_BYTES / JSONL_LINE_BYTES,
      malformed_records: 3,
      rare_status_records: 1
    }
  };
}

function csvCell(value) {
  return /[",\r\n]/u.test(value)
    ? `"${value.replaceAll('"', '""')}"`
    : value;
}

function buildCsv() {
  const header = ["id", ...Array.from(
    { length: 29 }, (_, index) => `c${String(index + 1).padStart(2, "0")}`
  )];
  const rows = Array.from({ length: 100_000 }, (_, index) => {
    const values = Array(30).fill("");
    values[0] = String(index + 1);
    if (index === 1) values[2] = "quoted\nnewline";
    if (index === 2) values[3] = "Việt";
    if (index === 4) values[5] = "9007199254740993";
    if (index === 42_423) values[1] = "target_customer";
    return `${values.map(csvCell).join(",")}\n`;
  });
  return {
    dataset_id: "CSV_100K",
    task_id: "BENCH-TABLE-004",
    media_type: "text/csv",
    text: `${header.join(",")}\n${rows.join("")}`,
    shape: {
      columns: 30,
      large_integer_records: 1,
      quoted_newline_records: 1,
      rows: 100_000,
      target_records: 1,
      unicode_records: 1
    }
  };
}

export function buildTargetCorpus() {
  return [buildLog(), buildJson(), buildJsonl(), buildCsv()];
}

export function buildTargetDataset(taskId) {
  const builders = {
    "BENCH-READ-001": buildLog,
    "BENCH-JSON-002": buildJson,
    "BENCH-STREAM-003": buildJsonl,
    "BENCH-TABLE-004": buildCsv
  };
  if (!Object.hasOwn(builders, taskId)) {
    throw new TypeError("unknown target corpus task");
  }
  return builders[taskId]();
}

function retrievedView(store, dataset, artifactId) {
  if (dataset.dataset_id === "LOG_80K") {
    return store.search(artifactId, ROOT_CAUSE, 1, 512);
  }
  if (dataset.dataset_id === "JSON_50K") {
    return store.project(artifactId, {
      format: "json",
      fields: [
        "/id",
        "/customer_id",
        "/record/customer/account/profile/state/status"
      ],
      filter: {
        pointer: "/record/customer/account/profile/state/status",
        equals: "rare_status"
      },
      limit: 1000,
      maxTokens: 512
    });
  }
  if (dataset.dataset_id === "JSONL_25MB") {
    return store.project(artifactId, {
      format: "jsonl",
      fields: ["/id", "/status"],
      filter: { pointer: "/status", equals: "rare_status" },
      limit: 1000,
      maxTokens: 512
    });
  }
  return store.project(artifactId, {
    format: "csv",
    columns: ["id", "c01"],
    filter: { column: "c01", equals: "target_customer" },
    limit: 1000,
    maxTokens: 512
  });
}

function oracle(dataset, view) {
  if (dataset.dataset_id === "LOG_80K") {
    return view.content.includes(ROOT_CAUSE);
  }
  const records = view.content.trimEnd().split("\n").filter(Boolean)
    .map(JSON.parse);
  if (dataset.dataset_id === "JSON_50K") {
    return records.length === 1 && records[0]["/id"] === 42_424 &&
      records[0]["/customer_id"] === "customer-target-42424";
  }
  if (dataset.dataset_id === "JSONL_25MB") {
    return records.length === 1 && records[0]["/id"] === 77_777 &&
      view.diagnostics.filter(
        ({ code }) => code === "EG-PROJECT-JSONL-001"
      ).length === 3;
  }
  return records.length === 1 && records[0].id === "42424" &&
    records[0].c01 === "target_customer";
}

function qualifyDataset(dataset) {
  const sourceDigest = digest(dataset.text);
  const bytes = Buffer.byteLength(dataset.text, "utf8");
  const store = new ContextStore();
  try {
    const first = store.ingest(dataset.text, dataset.media_type);
    const retrieved = retrievedView(store, dataset, first.artifact_id);
    const rawTokens = Math.ceil(bytes / 4);
    const firstViewReduction = Number(
      (1 - first.token_count.value / rawTokens).toFixed(6)
    );
    const citationsBound = retrieved.citations.length > 0 &&
      retrieved.citations.every(
        ({ source_digest: value }) => value === sourceDigest
      );
    const checks = {
      bounded_first_view: first.budget.applied_bytes <= 4096,
      citation_integrity: citationsBound,
      corpus_digest: sourceDigest === EXPECTED_DIGESTS[dataset.dataset_id],
      first_view_reduction: firstViewReduction >= 0.70,
      task_oracle: oracle(dataset, retrieved)
    };
    return {
      dataset_id: dataset.dataset_id,
      task_id: dataset.task_id,
      media_type: dataset.media_type,
      artifact_digest: sourceDigest,
      bytes,
      shape: dataset.shape,
      measurements: {
        first_view_bytes: first.budget.applied_bytes,
        first_view_reduction: firstViewReduction,
        first_view_tokens: first.token_count.value,
        raw_byte_proxy_tokens: rawTokens
      },
      checks,
      verdict: Object.values(checks).every(Boolean) ? "pass" : "fail"
    };
  } finally {
    store.close();
  }
}

export function qualifyTargetCorpusFixture({ sourceCommit } = {}) {
  if (!COMMIT.test(sourceCommit ?? "")) {
    throw new TypeError("target corpus requires a full source commit");
  }
  const tasks = buildTargetCorpus().map(qualifyDataset);
  const checks = {
    all_context_tasks_pass: tasks.every(({ verdict }) => verdict === "pass"),
    exact_dataset_count: tasks.length === 4
  };
  return deepFreeze({
    kind: "effectgate_target_corpus_context_qualification",
    schema_version: "1.0.0",
    source_commit: sourceCommit,
    scope: "context_plane",
    release_gate_eligible: false,
    transport: {
      exact_corpus_mcp_stdio_qualified: false,
      jsonl_frame_limit_bytes: MAX_FRAME_BYTES,
      reason: "mcp_stdio_requires_bounded_frames"
    },
    tasks,
    checks,
    verdict: Object.values(checks).every(Boolean) ? "pass" : "fail"
  });
}

export function main(args = process.argv.slice(2)) {
  if (args.length !== 2 || args[0] !== "--source-commit") {
    throw new Error(USAGE);
  }
  const qualification = qualifyTargetCorpusFixture({ sourceCommit: args[1] });
  process.stdout.write(`${canonicalJson(qualification)}\n`);
  if (qualification.verdict === "fail") process.exitCode = 1;
  return qualification;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    process.stderr.write(`[effectgate-target-fixture] ${error.message}\n`);
    process.exitCode = 2;
  }
}
