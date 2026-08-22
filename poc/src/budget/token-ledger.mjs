import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { dirname, resolve } from "node:path";

const MAX_LEDGER_BYTES = 64 * 1024 * 1024;
const MAX_LEDGER_ENTRIES = 1_000_000;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const PROFILES = new Set([
  "native_default", "native_deferred", "compact_mux", "direct_bypass",
  "eager_diagnostic"
]);
const STAGES = new Set([
  "tool_metadata", "backend_raw_result", "redacted_artifact", "first_view",
  "fetch_page", "public_error", "receipt", "host_turn", "host_session",
  "paired_baseline", "skill_catalog", "skill_instruction",
  "instruction_dependency", "phase_receipt", "verification"
]);
const DIRECTIONS = new Set(["to_host", "from_host", "internal", "counterfactual"]);
const BASES = new Set([
  "host_reported", "tokenizer_exact", "tokenizer_estimate", "byte_proxy",
  "counterfactual"
]);
const CATEGORIES = new Set([
  "tool_schema_tokens_emitted", "tool_result_tokens_emitted",
  "context_view_tokens_emitted", "repeated_context_tokens_avoided",
  "skill_catalog_tokens_emitted", "skill_discovery_tokens_avoided",
  "skill_instruction_tokens_emitted", "skill_instruction_tokens_avoided",
  "instruction_dependency_fetch_tokens", "phase_receipt_tokens_emitted",
  "verification_overhead_tokens", "net_tokens_avoided"
]);
const SAFE_METADATA_KEYS = new Set([
  "category", "comparator", "source_digest"
]);
const TOKEN_COUNT_KEYS = new Set([
  "value", "basis", "counter_id", "counter_version", "input_digest",
  "calibration_error_bound"
]);
const ENTRY_KEYS = new Set([
  "entry_id", "artifact_id", "view_id", "stage", "direction", "token_count",
  "bytes", "observed_at", "safe_metadata"
]);

export class CorruptTokenLedgerError extends Error {
  constructor() {
    super("token ledger failed validation");
    this.name = "CorruptTokenLedgerError";
  }
}

export class TokenLedgerWriteError extends Error {
  constructor() {
    super("token ledger write failed");
    this.name = "TokenLedgerWriteError";
  }
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function validTimestamp(value) {
  if (typeof value !== "string") return false;
  try {
    return new Date(value).toISOString() === value;
  } catch {
    return false;
  }
}

function validId(value, prefix) {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 128 &&
    (prefix === undefined ||
      new RegExp(`^${prefix}_[A-Za-z0-9_-]{16,128}$`, "u").test(value))
  );
}

function validTokenCount(value, bytes) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !TOKEN_COUNT_KEYS.has(key)) ||
    !Number.isSafeInteger(value.value) ||
    value.value < 0 ||
    !BASES.has(value.basis) ||
    !validId(value.counter_id) ||
    !validId(value.counter_version) ||
    typeof value.input_digest !== "string" ||
    !DIGEST_PATTERN.test(value.input_digest) ||
    (value.calibration_error_bound !== undefined &&
      (!Number.isFinite(value.calibration_error_bound) ||
        value.calibration_error_bound < 0 ||
        value.calibration_error_bound > 1))
  ) {
    return false;
  }
  return value.basis !== "byte_proxy" ||
    value.value === Math.ceil(bytes / 4);
}

function validatedEntry(value) {
  const metadata = value?.safe_metadata;
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !ENTRY_KEYS.has(key)) ||
    !validId(value.entry_id, "ent") ||
    (value.artifact_id !== undefined && !validId(value.artifact_id)) ||
    (value.view_id !== undefined && !validId(value.view_id)) ||
    !STAGES.has(value.stage) ||
    !DIRECTIONS.has(value.direction) ||
    !Number.isSafeInteger(value.bytes) ||
    value.bytes < 0 ||
    !validTokenCount(value.token_count, value.bytes) ||
    !validTimestamp(value.observed_at) ||
    (metadata !== undefined &&
      (metadata === null ||
        typeof metadata !== "object" ||
        Array.isArray(metadata) ||
        Object.keys(metadata).some((key) => !SAFE_METADATA_KEYS.has(key)) ||
        !CATEGORIES.has(metadata.category) ||
        (value.direction === "counterfactual"
          ? !validId(metadata.comparator) ||
            !DIGEST_PATTERN.test(metadata.source_digest ?? "")
          : metadata.comparator !== undefined ||
            metadata.source_digest !== undefined)))
  ) {
    throw new CorruptTokenLedgerError();
  }
  const tokenCount = { ...value.token_count };
  const entry = {
    ...value,
    token_count: Object.freeze(tokenCount),
    ...(metadata === undefined
      ? {}
      : { safe_metadata: Object.freeze({ ...metadata }) })
  };
  return Object.freeze(entry);
}

function readLedger(file) {
  const size = fs.statSync(file).size;
  if (size < 1 || size > MAX_LEDGER_BYTES) {
    throw new CorruptTokenLedgerError();
  }
  const text = fs.readFileSync(file, "utf8");
  if (!text.endsWith("\n")) throw new CorruptTokenLedgerError();
  const lines = text.slice(0, -1).split("\n");
  let header;
  let entries;
  try {
    header = JSON.parse(lines[0]);
    entries = lines.slice(1).map((line) => validatedEntry(JSON.parse(line)));
  } catch (error) {
    if (error instanceof CorruptTokenLedgerError) throw error;
    throw new CorruptTokenLedgerError();
  }
  if (
    header?.kind !== "effectgate_token_ledger" ||
    header.schema_version !== "1.0.0" ||
    !validId(header.ledger_id, "led") ||
    !validId(header.run_id) ||
    !validId(header.session_id) ||
    !PROFILES.has(header.profile) ||
    !validTimestamp(header.created_at) ||
    Object.keys(header).length !== 7 ||
    entries.length > MAX_LEDGER_ENTRIES ||
    new Set(entries.map(({ entry_id }) => entry_id)).size !== entries.length
  ) {
    throw new CorruptTokenLedgerError();
  }
  return { header: Object.freeze(header), entries };
}

export function loadTokenLedger(file) {
  if (typeof file !== "string" || file.length < 1 ||
      Buffer.byteLength(file, "utf8") > 1024 || file.includes("\0")) {
    throw new TypeError("invalid token ledger file");
  }
  const absolute = resolve(file);
  const stat = fs.lstatSync(absolute);
  if (!stat.isFile()) throw new CorruptTokenLedgerError();
  const ledger = readLedger(fs.realpathSync(absolute));
  return Object.freeze({
    header: ledger.header,
    entries: Object.freeze(ledger.entries)
  });
}

export class TokenLedger {
  constructor({ file, runId, sessionId, profile = "native_deferred", now = Date.now }) {
    if (
      typeof file !== "string" ||
      file.length < 1 ||
      Buffer.byteLength(file, "utf8") > 1024 ||
      file.includes("\0") ||
      !validId(runId) ||
      !validId(sessionId) ||
      !PROFILES.has(profile) ||
      typeof now !== "function"
    ) {
      throw new TypeError("invalid token ledger configuration");
    }
    this.file = resolve(file);
    this.now = now;
    this.closed = false;
    fs.mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 });

    if (fs.existsSync(this.file)) {
      const stored = readLedger(this.file);
      if (
        stored.header.run_id !== runId ||
        stored.header.session_id !== sessionId ||
        stored.header.profile !== profile
      ) {
        throw new CorruptTokenLedgerError();
      }
      this.header = stored.header;
      this.entries = stored.entries;
    } else {
      const createdAt = new Date(now()).toISOString();
      this.header = Object.freeze({
        kind: "effectgate_token_ledger",
        schema_version: "1.0.0",
        ledger_id: `led_${randomBytes(18).toString("base64url")}`,
        run_id: runId,
        session_id: sessionId,
        profile,
        created_at: createdAt
      });
      this.entries = [];
      fs.writeFileSync(this.file, `${JSON.stringify(this.header)}\n`, {
        flag: "wx",
        mode: 0o600,
        flush: true
      });
    }
  }

  append({ stage, direction, tokenCount, bytes, artifactId, viewId, category,
    comparator, sourceDigest }) {
    if (this.closed) throw new Error("token ledger is closed");
    if (this.entries.length >= MAX_LEDGER_ENTRIES) {
      throw new RangeError("token ledger entry limit is full");
    }
    let entry;
    try {
      entry = validatedEntry({
        entry_id: `ent_${randomBytes(18).toString("base64url")}`,
        ...(artifactId === undefined ? {} : { artifact_id: artifactId }),
        ...(viewId === undefined ? {} : { view_id: viewId }),
        stage,
        direction,
        token_count: tokenCount,
        bytes,
        observed_at: new Date(this.now()).toISOString(),
        ...(category === undefined ? {} : {
          safe_metadata: {
            category,
            ...(comparator === undefined ? {} : { comparator }),
            ...(sourceDigest === undefined
              ? {}
              : { source_digest: sourceDigest })
          }
        })
      });
    } catch (error) {
      if (!(error instanceof CorruptTokenLedgerError)) throw error;
      throw new TypeError("invalid token ledger entry");
    }
    // ponytail: one proxy owns one ledger file; move to the EG-006 database
    // before multiple processes share a durable writer.
    try {
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, {
        encoding: "utf8",
        mode: 0o600,
        flush: true
      });
    } catch {
      throw new TokenLedgerWriteError();
    }
    this.entries.push(entry);
    return entry;
  }

  snapshot() {
    if (this.closed) throw new Error("token ledger is closed");
    const groups = Object.fromEntries([...BASES].map((basis) => [basis, 0]));
    for (const entry of this.entries) {
      groups[entry.token_count.basis] += entry.token_count.value;
    }
    const ledger = {
      schema_version: "1.0.0",
      ledger_id: this.header.ledger_id,
      run_id: this.header.run_id,
      session_id: this.header.session_id,
      profile: this.header.profile,
      entries: Object.freeze([...this.entries]),
      summary: Object.freeze({ measurement_basis_groups: Object.freeze(groups) }),
      created_at: this.header.created_at
    };
    return Object.freeze({
      ...ledger,
      integrity_digest: digest(JSON.stringify(ledger))
    });
  }

  verify() {
    if (this.closed) throw new Error("token ledger is closed");
    const stored = readLedger(this.file);
    if (
      JSON.stringify(stored.header) !== JSON.stringify(this.header) ||
      JSON.stringify(stored.entries) !== JSON.stringify(this.entries)
    ) {
      throw new CorruptTokenLedgerError();
    }
    return this.snapshot().integrity_digest;
  }

  close() {
    this.closed = true;
  }
}
