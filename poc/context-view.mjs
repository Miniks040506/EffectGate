import { createHash, randomBytes } from "node:crypto";

import {
  CursorService,
  InvalidCursorTokenError
} from "./cursor-service.mjs";
import { FilesystemCas } from "./filesystem-cas.mjs";
import {
  buildDocumentProjectionEntries,
  isValidProjectionOptions
} from "./document-project.mjs";
import {
  CONTEXT_PROJECT_MAX_LIMIT,
  CONTEXT_PROJECT_MAX_OFFSET,
  CONTEXT_PROJECT_MAX_TOKENS,
  CONTEXT_PROJECT_MIN_TOKENS,
  InvalidJsonProjectionError,
  buildJsonProjectionEntries,
  isUnicodeScalarText
} from "./json-project.mjs";

export const CONTEXT_PAGE_BYTES = 4096;
export const CONTEXT_MAX_ARTIFACT_BYTES = 1024 * 1024;
export const CONTEXT_STORE_BYTES = 4 * 1024 * 1024;
export const CONTEXT_CURSOR_TTL_MS = 10 * 60 * 1000;
export const CONTEXT_SEARCH_MAX_QUERY_LENGTH = 64;
export const CONTEXT_SEARCH_MAX_CONTEXT_LINES = 5;
export const CONTEXT_SEARCH_MIN_TOKENS = 64;
export const CONTEXT_SEARCH_MAX_TOKENS = 1024;

const TOKEN_COUNTER_ID = "utf8-bytes-ceil-div-4";
const PROJECTION_VERSION = "text-byte-page-redact-v1";
const SEARCH_PROJECTION_VERSION = "text-literal-search-redact-v1";
const JSON_PROJECTION_VERSION = "json-pointer-equality-slice-redact-v1";
const DOCUMENT_PROJECTION_VERSION = "tabular-markdown-redact-v1";
const MAX_SCHEMA_CONTENT_LENGTH = 262144;
const MAX_REDACTION_SPANS = 4096;
const MAX_PROJECT_PAGE_ITEMS = 100;
const REDACTION_MARKER = "[REDACTED]";
const OPAQUE_WINDOW_BYTES = 1024;
const OPAQUE_WINDOW_STRIDE = 512;
const OPAQUE_TOKEN_RUN_BYTES = 128;
const OPAQUE_ARMOR_BYTES = 256;
const OPAQUE_ARMOR_SPACE_RATIO = 8;

const REDACTION_RULESET_VERSION = "preview-v1";
const OPAQUE_DETECTOR_VERSION = "opaque-byte-distribution-v1";
const PRIVATE_KEY_MARKERS = [
  "-----BEGIN PRIVATE KEY-----",
  "-----BEGIN ENCRYPTED PRIVATE KEY-----",
  "-----BEGIN RSA PRIVATE KEY-----",
  "-----BEGIN EC PRIVATE KEY-----",
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "-----BEGIN PGP PRIVATE KEY BLOCK-----"
].map((marker) => Buffer.from(marker, "ascii"));
const REDACTION_RULES = Object.freeze([
  {
    ruleId: "secret-assignment-v1",
    class: "secret",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|password|secret)["']?\s*[:=]\s*["']?([^\s"',;}\]]{16,})/dgi,
    group: 1
  },
  {
    ruleId: "bearer-token-v1",
    class: "credential",
    pattern: /\bBearer\s+([^\s"',;}\]]{16,})/dgi,
    group: 1
  },
  {
    ruleId: "prefixed-token-v1",
    class: "credential",
    pattern: /\b((?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]{16,})\b/dg,
    group: 1
  }
]);

export class InvalidCursorError extends Error {
  constructor() {
    super("invalid retrieval cursor");
    this.name = "InvalidCursorError";
  }
}

export class InvalidArtifactError extends Error {
  constructor() {
    super("invalid artifact reference");
    this.name = "InvalidArtifactError";
  }
}

export class ContextRetentionError extends RangeError {
  constructor() {
    super("artifact could not be retained");
    this.name = "ContextRetentionError";
  }
}

export class UnsafeArtifactError extends RangeError {
  constructor(message) {
    super(message);
    this.name = "UnsafeArtifactError";
  }
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function randomId(prefix, bytes = 18) {
  return `${prefix}_${randomBytes(bytes).toString("base64url")}`;
}

function tokenCount(bytes, inputDigest) {
  return {
    value: Math.ceil(bytes / 4),
    basis: "byte_proxy",
    counter_id: TOKEN_COUNTER_ID,
    counter_version: "1",
    input_digest: inputDigest
  };
}

function pageEnd(bytes, start, maxBytes) {
  let end = Math.min(start + maxBytes, bytes.length);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return end;
}

function lineStarts(text) {
  const starts = [0];
  for (let index = text.indexOf("\n"); index !== -1;) {
    starts.push(index + 1);
    index = text.indexOf("\n", index + 1);
  }
  return starts;
}

function lineAt(starts, stringIndex) {
  let low = 0;
  let high = starts.length;
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2);
    if (starts[middle] <= stringIndex) low = middle;
    else high = middle;
  }
  return low;
}

function stringIndexAtByte(offsets, byteOffset) {
  let low = 0;
  let high = offsets.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (offsets[middle] < byteOffset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function boundedWindow(bytes, start, end, matchStart, matchEnd, maxBytes) {
  if (end - start <= maxBytes) return { start, end };
  const minimumStart = start;
  const matchBytes = matchEnd - matchStart;
  const before = Math.min(
    matchStart - start,
    Math.floor((maxBytes - matchBytes) / 2)
  );
  start = matchStart - before;
  end = Math.min(end, start + maxBytes);
  start = Math.max(
    start - Math.max(0, maxBytes - (end - start)),
    minimumStart
  );
  while (start < matchStart && (bytes[start] & 0xc0) === 0x80) start += 1;
  while (
    end > matchEnd &&
    end < bytes.length &&
    (bytes[end] & 0xc0) === 0x80
  ) {
    end -= 1;
  }
  return { start, end };
}

function* utf8Chunks(text, maxBytes = 64 * 1024) {
  const encoder = new TextEncoder();
  const buffer = Buffer.allocUnsafe(maxBytes);
  for (let start = 0; start < text.length;) {
    const { read, written } = encoder.encodeInto(text.slice(start), buffer);
    if (read === 0) throw new Error("UTF-8 encoding made no progress");
    yield buffer.subarray(0, written);
    start += read;
  }
}

function utf8ByteOffsets(text) {
  const offsets = new Uint32Array(text.length + 1);
  let byteOffset = 0;

  for (let index = 0; index < text.length; index += 1) {
    offsets[index] = byteOffset;
    const codePoint = text.codePointAt(index);
    if (codePoint > 0xffff) {
      offsets[index + 1] = byteOffset;
      index += 1;
    }
    byteOffset +=
      codePoint <= 0x7f ? 1 : codePoint <= 0x7ff ? 2 : codePoint <= 0xffff ? 3 : 4;
    offsets[index + 1] = byteOffset;
  }
  return offsets;
}

function scanRedactions(text) {
  const offsets = utf8ByteOffsets(text);
  const spans = [];

  for (const rule of REDACTION_RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const indices = match.indices?.[rule.group];
      if (!indices || indices[0] === indices[1]) continue;
      spans.push({
        byteStart: offsets[indices[0]],
        byteEnd: offsets[indices[1]],
        class: rule.class,
        ruleId: rule.ruleId
      });
      if (spans.length > MAX_REDACTION_SPANS) {
        throw new UnsafeArtifactError(
          "artifact exceeds the redaction span limit"
        );
      }
    }
  }
  return spans.sort(
    (left, right) =>
      left.byteStart - right.byteStart || right.byteEnd - left.byteEnd
  );
}

function supportedTextMediaType(mediaType) {
  const essence = mediaType.split(";", 1)[0].trim().toLowerCase();
  return (
    essence.startsWith("text/") ||
    essence === "application/json" ||
    essence === "application/x-ndjson" ||
    essence.endsWith("+json")
  );
}

function opaqueTokenByte(byte) {
  return (
    (byte >= 0x30 && byte <= 0x39) ||
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    byte === 0x2b ||
    byte === 0x2d ||
    byte === 0x2e ||
    byte === 0x2f ||
    byte === 0x3d ||
    byte === 0x5f
  );
}

function opaqueConcentration(counts, bytes, maximum) {
  let collisions = 0;
  for (const count of counts) collisions += count * (count - 1);
  return 1024 * collisions <= maximum * bytes * (bytes - 1);
}

function hasOpaqueByteDistribution(bytes) {
  if (PRIVATE_KEY_MARKERS.some((marker) => bytes.includes(marker))) return true;

  const seen = new Uint32Array(256);
  const armorCounts = new Uint32Array(256);
  const armorTouched = [];
  let runId = 1;
  let runBytes = 0;
  let runDistinct = 0;
  let armorBytes = 0;
  let armorDistinct = 0;
  let armorIsHex = true;
  let armorSpaces = 0;
  let atLineStart = true;
  const resetArmor = () => {
    for (const byte of armorTouched) armorCounts[byte] = 0;
    armorTouched.length = 0;
    armorBytes = 0;
    armorDistinct = 0;
    armorIsHex = true;
    armorSpaces = 0;
  };
  const opaqueArmor = () =>
    armorBytes >= OPAQUE_ARMOR_BYTES &&
    armorSpaces * OPAQUE_ARMOR_SPACE_RATIO <= armorBytes &&
    ((armorDistinct >= 48 &&
      opaqueConcentration(armorCounts, armorBytes, 24)) ||
      (armorIsHex &&
        armorDistinct >= 12 &&
        opaqueConcentration(armorCounts, armorBytes, 80)));

  for (let index = 0; index < bytes.length; index += 1) {
    const byte = bytes[index];
    if (opaqueTokenByte(byte)) {
      atLineStart = false;
      runBytes += 1;
      if (seen[byte] !== runId) {
        seen[byte] = runId;
        runDistinct += 1;
      }
      armorBytes += 1;
      if (armorCounts[byte]++ === 0) {
        armorTouched.push(byte);
        armorDistinct += 1;
      }
      if (
        !(
          (byte >= 0x30 && byte <= 0x39) ||
          (byte >= 0x41 && byte <= 0x46) ||
          (byte >= 0x61 && byte <= 0x66)
        )
      ) {
        armorIsHex = false;
      }
      if (
        runBytes >= OPAQUE_TOKEN_RUN_BYTES &&
        runDistinct >= 12
      ) {
        return true;
      }
      continue;
    }

    if (opaqueArmor()) return true;
    const escapedWhitespace =
      byte === 0x5c &&
      index + 1 < bytes.length &&
      (bytes[index + 1] === 0x6e ||
        bytes[index + 1] === 0x72 ||
        bytes[index + 1] === 0x74);
    const lineBreak =
      byte === 0x0a ||
      byte === 0x0d ||
      (escapedWhitespace &&
        (bytes[index + 1] === 0x6e || bytes[index + 1] === 0x72));
    const horizontalWhitespace =
      byte === 0x20 ||
      byte === 0x09 ||
      (escapedWhitespace && bytes[index + 1] === 0x74);
    const indentation = horizontalWhitespace && atLineStart;
    if (escapedWhitespace) index += 1;
    if (indentation && armorBytes > 0) armorSpaces += 1;
    const armorWhitespace = lineBreak || indentation;
    if (
      !armorWhitespace ||
      (armorBytes > 0 &&
        armorSpaces * OPAQUE_ARMOR_SPACE_RATIO > armorBytes)
    ) {
      resetArmor();
    }
    if (lineBreak) atLineStart = true;
    if (runBytes > 0) {
      runBytes = 0;
      runDistinct = 0;
      runId += 1;
    }
  }
  if (opaqueArmor()) return true;

  // ponytail: artifacts are capped at 1 MiB; revisit only if corpus evidence
  // shows this conservative integer screen needs a streaming implementation.
  const counts = new Uint32Array(256);
  for (
    let start = 0;
    start + OPAQUE_WINDOW_BYTES <= bytes.length;
    start = Math.min(
      start + OPAQUE_WINDOW_STRIDE,
      bytes.length - OPAQUE_WINDOW_BYTES
    )
  ) {
    counts.fill(0);
    let distinct = 0;
    for (let index = start; index < start + OPAQUE_WINDOW_BYTES; index += 1) {
      if (counts[bytes[index]]++ === 0) distinct += 1;
    }
    if (distinct >= 48) {
      if (opaqueConcentration(counts, OPAQUE_WINDOW_BYTES, 24)) {
        return true;
      }
    }
    if (start === bytes.length - OPAQUE_WINDOW_BYTES) break;
  }
  return false;
}

function artifactDiagnostics(artifact) {
  return [
    ...(artifact.retainedResult
      ? [
          {
            code: "EG-VIEW-RESULT-001",
            message: artifact.opaque
              ? "The original tool-result envelope was retained, but model-visible content was withheld."
              : "The original tool-result envelope was retained and is shown as bounded JSON."
          }
        ]
      : []),
    {
      code: "EG-REDACT-001",
      message: `Deterministic redaction ruleset ${REDACTION_RULESET_VERSION} was applied.`
    }
  ];
}

function renderRedactedPage(artifact, page, start, end) {
  const relevant = artifact.redactionSpans.filter(
    (span) => span.byteEnd > start && span.byteStart < end
  );
  const content = [];
  let position = start;

  for (const span of relevant) {
    const redactionStart = Math.max(position, span.byteStart, start);
    const redactionEnd = Math.min(span.byteEnd, end);
    if (redactionEnd <= redactionStart) continue;
    if (redactionStart > position) {
      content.push(
        new TextDecoder("utf-8", { fatal: true }).decode(
          page.subarray(position - start, redactionStart - start)
        )
      );
    }
    const redactedBytes = redactionEnd - redactionStart;
    content.push(
      redactedBytes >= REDACTION_MARKER.length
        ? REDACTION_MARKER
        : "*".repeat(redactedBytes)
    );
    position = redactionEnd;
  }
  if (position < end) {
    content.push(
      new TextDecoder("utf-8", { fatal: true }).decode(
        page.subarray(position - start, end - start)
      )
    );
  }

  const counts = new Map();
  for (const span of relevant) {
    const key = `${span.class}:${span.ruleId}`;
    const current = counts.get(key) ?? {
      class: span.class,
      count: 0,
      rule_id: span.ruleId
    };
    current.count += 1;
    counts.set(key, current);
  }
  return { content: content.join(""), redactions: [...counts.values()] };
}

function finalizeView(view, artifact, projectionVersion) {
  const appliedBytes = Buffer.byteLength(view.content, "utf8");
  const appliedTokens = Math.ceil(appliedBytes / 4);
  if (
    appliedBytes !== view.budget.applied_bytes ||
    appliedTokens !== view.budget.applied_tokens ||
    appliedBytes > view.budget.max_bytes ||
    appliedTokens > view.budget.max_tokens
  ) {
    throw new RangeError("Context View exceeds its declared budget");
  }
  if (
    (view.status === "partial_view" || view.status === "unavailable") &&
    !view.diagnostics.some(({ code }) => code === "EG-VIEW-002")
  ) {
    view.diagnostics.push({
      code: "EG-VIEW-002",
      message: view.retrieval?.operations?.length
        ? "Source data was omitted from this bounded view; use the listed retrieval operations when needed."
        : "Source data was omitted from this bounded view and no model-visible retrieval is available."
    });
  }
  view.integrity = {
    artifact_digest: artifact.sourceDigest,
    view_digest: digest(
      Buffer.from(
        JSON.stringify({
          ...view,
          integrity: {
            artifact_digest: artifact.sourceDigest,
            projection_version: projectionVersion
          }
        }),
        "utf8"
      )
    ),
    projection_version: projectionVersion
  };
  return view;
}

export class ContextStore {
  constructor({
    pageBytes = CONTEXT_PAGE_BYTES,
    maxArtifactBytes = CONTEXT_MAX_ARTIFACT_BYTES,
    maxStoreBytes = CONTEXT_STORE_BYTES,
    maxArtifacts = 16,
    maxCursors = 64,
    cursorTtlMs = CONTEXT_CURSOR_TTL_MS,
    now = Date.now,
    casDirectory
  } = {}) {
    for (const [name, value, minimum] of [
      ["pageBytes", pageBytes, 4],
      ["maxArtifactBytes", maxArtifactBytes, 1],
      ["maxStoreBytes", maxStoreBytes, 1],
      ["maxArtifacts", maxArtifacts, 1],
      ["maxCursors", maxCursors, 2],
      ["cursorTtlMs", cursorTtlMs, 1]
    ]) {
      if (!Number.isSafeInteger(value) || value < minimum) {
        throw new TypeError(`${name} must be an integer >= ${minimum}`);
      }
    }
    if (maxArtifactBytes > maxStoreBytes) {
      throw new TypeError("maxArtifactBytes must not exceed maxStoreBytes");
    }
    if (pageBytes > MAX_SCHEMA_CONTENT_LENGTH) {
      throw new TypeError(
        `pageBytes must be <= ${MAX_SCHEMA_CONTENT_LENGTH}`
      );
    }
    if (typeof now !== "function") throw new TypeError("now must be a function");

    this.pageBytes = pageBytes;
    this.maxArtifactBytes = maxArtifactBytes;
    this.maxStoreBytes = maxStoreBytes;
    this.maxArtifacts = maxArtifacts;
    this.now = now;
    this.cas = new FilesystemCas({
      directory: casDirectory,
      maxObjectBytes: maxArtifactBytes
    });
    this.sessionId = randomId("sess");
    this.cursorService = new CursorService({
      maxCursors,
      ttlMs: cursorTtlMs,
      now,
      principalId: "preview-local-user",
      clientId: randomId("client"),
      sessionId: this.sessionId,
      policyGeneration: "preview-readonly-v1"
    });
    this.artifacts = new Map();
    this.storedBytes = 0;
  }

  requiresView(text, mediaType = "text/plain") {
    if (typeof text !== "string" || typeof mediaType !== "string") {
      return true;
    }
    if (text.length > this.maxArtifactBytes) return true;
    if (!isUnicodeScalarText(text)) return true;
    const bytes = Buffer.from(text, "utf8");
    if (bytes.length > this.maxArtifactBytes) return true;
    return (
      scanRedactions(text).length > 0 ||
      !supportedTextMediaType(mediaType) ||
      hasOpaqueByteDistribution(bytes)
    );
  }

  ingest(
    text,
    mediaType = "text/plain",
    { retainedResult = false } = {}
  ) {
    if (typeof text !== "string" || typeof mediaType !== "string") {
      throw new TypeError("text and mediaType must be strings");
    }
    if (typeof retainedResult !== "boolean") {
      throw new TypeError("retainedResult must be a boolean");
    }
    if (!isUnicodeScalarText(text)) {
      throw new TypeError("text must contain only Unicode scalar values");
    }
    const mediaTypeLength = [...mediaType].length;
    if (mediaTypeLength < 1 || mediaTypeLength > 128) {
      throw new TypeError("mediaType must contain 1 through 128 characters");
    }

    const byteLength = Buffer.byteLength(text, "utf8");
    if (
      byteLength > this.maxArtifactBytes ||
      byteLength > this.maxStoreBytes
    ) {
      throw new ContextRetentionError();
    }

    const sourceDigest = digest(text);
    const artifactId = `art_${sourceDigest.slice("sha256:".length)}`;
    let artifact = this.artifacts.get(artifactId);

    if (artifact) {
      if (
        artifact.mediaType !== mediaType ||
        artifact.retainedResult !== retainedResult
      ) {
        throw new TypeError("artifact metadata conflicts with existing content");
      }
      this.artifacts.delete(artifactId);
      this.artifacts.set(artifactId, artifact);
    } else {
      const redactionSpans = scanRedactions(text);
      const opaque =
        !supportedTextMediaType(mediaType) ||
        hasOpaqueByteDistribution(Buffer.from(text, "utf8"));
      this.pruneExpiredCursors();
      while (
        this.artifacts.size >= this.maxArtifacts ||
        this.storedBytes + byteLength > this.maxStoreBytes
      ) {
        const oldest = [...this.artifacts.keys()].find(
          (candidate) => !this.isPinned(candidate)
        );
        if (oldest === undefined) {
          throw new ContextRetentionError();
        }
        this.dropArtifact(oldest);
      }
      let stored;
      try {
        stored = this.cas.put(utf8Chunks(text), {
          expectedBytes: byteLength,
          expectedDigest: sourceDigest
        });
      } catch (error) {
        if (typeof error?.code === "string") {
          throw new ContextRetentionError();
        }
        throw error;
      }
      artifact = {
        artifactId,
        sourceDigest,
        byteLength: stored.bytes,
        mediaType,
        redactionSpans,
        opaque,
        retainedResult
      };
      this.artifacts.set(artifactId, artifact);
      this.storedBytes += stored.bytes;
    }

    return this.createView(artifact, 0);
  }

  search(
    artifactId,
    query,
    contextLines = 1,
    maxTokens = 512
  ) {
    if (typeof artifactId !== "string") throw new InvalidArtifactError();
    if (
      typeof query !== "string" ||
      query.length < 1 ||
      query.length > CONTEXT_SEARCH_MAX_QUERY_LENGTH * 2 ||
      !isUnicodeScalarText(query) ||
      [...query].length > CONTEXT_SEARCH_MAX_QUERY_LENGTH ||
      Buffer.byteLength(query, "utf8") >
        CONTEXT_SEARCH_MAX_QUERY_LENGTH * 4
    ) {
      throw new TypeError("query is invalid");
    }
    if (
      !Number.isSafeInteger(contextLines) ||
      contextLines < 0 ||
      contextLines > CONTEXT_SEARCH_MAX_CONTEXT_LINES
    ) {
      throw new TypeError("contextLines is invalid");
    }
    if (
      !Number.isSafeInteger(maxTokens) ||
      maxTokens < CONTEXT_SEARCH_MIN_TOKENS ||
      maxTokens > CONTEXT_SEARCH_MAX_TOKENS
    ) {
      throw new TypeError("maxTokens is invalid");
    }

    const artifact = this.artifacts.get(artifactId);
    if (!artifact) throw new InvalidArtifactError();
    this.artifacts.delete(artifactId);
    this.artifacts.set(artifactId, artifact);
    return this.createSearchView(artifact, {
      query,
      contextLines,
      maxTokens,
      offset: 0
    });
  }

  project(
    artifactId,
    {
      format,
      fields = [],
      columns = [],
      filter,
      heading,
      offset = 0,
      limit = 100,
      maxTokens = 512
    } = {}
  ) {
    if (typeof artifactId !== "string") throw new InvalidArtifactError();
    if (
      !isValidProjectionOptions({
        format,
        fields,
        columns,
        filter,
        heading
      }) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      offset > CONTEXT_PROJECT_MAX_OFFSET ||
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > CONTEXT_PROJECT_MAX_LIMIT ||
      !Number.isSafeInteger(maxTokens) ||
      maxTokens < CONTEXT_PROJECT_MIN_TOKENS ||
      maxTokens > CONTEXT_PROJECT_MAX_TOKENS
    ) {
      throw new TypeError("projection options are invalid");
    }

    const artifact = this.artifacts.get(artifactId);
    if (!artifact) throw new InvalidArtifactError();
    this.artifacts.delete(artifactId);
    this.artifacts.set(artifactId, artifact);
    return this.createProjectView(artifact, {
      format,
      fields: [...fields],
      columns: [...columns],
      ...(filter ? { filter: { ...filter } } : {}),
      ...(heading !== undefined ? { heading } : {}),
      sliceOffset: offset,
      sliceLimit: limit,
      maxTokens,
      offset: 0
    });
  }

  fetch(cursor) {
    let position;
    try {
      position = this.cursorService.resolve(cursor);
    } catch (error) {
      if (!(error instanceof InvalidCursorTokenError)) throw error;
      throw new InvalidCursorError();
    }
    if (position.view) return position.view;

    const artifact = this.artifacts.get(position.artifactId);
    if (!artifact) throw new InvalidCursorError();
    this.artifacts.delete(artifact.artifactId);
    this.artifacts.set(artifact.artifactId, artifact);
    const view = position.operation.search
      ? this.createSearchView(
          artifact,
          { ...position.operation.search, offset: position.offset },
          true
        )
      : position.operation.project
        ? this.createProjectView(
            artifact,
            { ...position.operation.project, offset: position.offset },
            true
          )
        : this.createView(
            artifact,
            position.offset,
            true,
            position.budget
          );
    position.view = view;
    return view;
  }

  dropArtifact(artifactId) {
    const artifact = this.artifacts.get(artifactId);
    if (!artifact) return;
    this.cas.remove(artifact.sourceDigest);
    this.artifacts.delete(artifactId);
    this.storedBytes -= artifact.byteLength;
  }

  close() {
    this.cursorService.clear();
    this.artifacts.clear();
    this.storedBytes = 0;
    this.cas.close();
  }

  pruneExpiredCursors() {
    this.cursorService.prune();
  }

  isPinned(artifactId) {
    return this.cursorService.isPinned(artifactId);
  }

  createCursor(
    artifactId,
    viewId,
    offset,
    budget,
    advancing,
    operation = { type: "text" }
  ) {
    return this.cursorService.issue({
      artifactId,
      viewId,
      offset,
      budget,
      advancing,
      operation
    });
  }

  createUnavailableView(artifact, maxBytes, projectionVersion) {
    const view = {
      schema_version: "1.0.0",
      view_id: randomId("view"),
      artifact_id: artifact.artifactId,
      session_id: this.sessionId,
      status: "unavailable",
      media_type: artifact.mediaType,
      content: "",
      budget: {
        max_tokens: Math.ceil(maxBytes / 4),
        max_bytes: maxBytes,
        applied_tokens: 0,
        applied_bytes: 0,
        overflow: "failed"
      },
      token_count: tokenCount(0, digest(Buffer.alloc(0))),
      estimated_raw_token_count: tokenCount(
        artifact.byteLength,
        artifact.sourceDigest
      ),
      citations: [],
      redactions: [],
      diagnostics: [
        {
          code: "EG-VIEW-OPAQUE-001",
          message:
            `Content was withheld by ${OPAQUE_DETECTOR_VERSION}; ` +
            "no summary was generated."
        },
        ...artifactDiagnostics(artifact)
      ],
      integrity: {}
    };
    return finalizeView(view, artifact, projectionVersion);
  }

  createProjectView(
    artifact,
    {
      format,
      fields,
      columns,
      filter,
      heading,
      sliceOffset,
      sliceLimit,
      maxTokens,
      offset
    },
    advancing = false
  ) {
    if (artifact.opaque) {
      return this.createUnavailableView(
        artifact,
        maxTokens * 4,
        format === "json" || format === "jsonl"
          ? JSON_PROJECTION_VERSION
          : DOCUMENT_PROJECTION_VERSION
      );
    }
    // ponytail: artifacts are capped at 1 MiB; add a streaming index if that
    // ceiling changes or projection latency becomes measurable.
    const raw = this.cas.readRange(
      artifact.sourceDigest,
      0,
      artifact.byteLength,
      artifact.byteLength
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    let projection;
    try {
      const options = {
        artifact,
        text,
        format,
        fields,
        columns,
        filter,
        heading,
        ...(format !== "json"
          ? {
              starts: lineStarts(text),
              offsets: utf8ByteOffsets(text)
            }
          : {}),
        render(start, end) {
          return renderRedactedPage(
            artifact,
            raw.subarray(start, end),
            start,
            end
          );
        }
      };
      projection =
        format === "json" || format === "jsonl"
          ? buildJsonProjectionEntries(options)
          : buildDocumentProjectionEntries(options);
    } catch (error) {
      if (error instanceof InvalidJsonProjectionError) {
        const fallback = this.createView(
          artifact,
          0,
          advancing,
          maxTokens * 4
        );
        fallback.diagnostics.unshift({
          code: "EG-PROJECT-JSON-001",
          message:
            "JSON projection failed without repair; bounded text fallback was applied."
        });
        return finalizeView(
          fallback,
          artifact,
          JSON_PROJECTION_VERSION
        );
      }
      throw error;
    }

    const { entries, commonRedactions } = projection;
    const selected = entries.slice(
      sliceOffset,
      sliceOffset + sliceLimit
    );
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > selected.length) {
      throw new InvalidCursorError();
    }

    const maxBytes = maxTokens * 4;
    const chunks = [];
    const citations = [];
    const citationIndexes = new Map();
    const recordCitations = [];
    const redactionCounts = new Map();
    const diagnostics = [
      projection.diagnostic,
      ...artifactDiagnostics(artifact)
    ];
    let appliedBytes = 0;
    let position = offset;
    let pageItems = 0;
    let omitted = false;

    const addCitation = (citation) => {
      const key = `${citation.byte_start}:${citation.byte_end}`;
      if (citationIndexes.has(key)) return citationIndexes.get(key);
      const index = citations.length;
      citations.push(citation);
      citationIndexes.set(key, index);
      return index;
    };
    const addRedactions = (redactions) => {
      for (const redaction of redactions) {
        const key = `${redaction.class}:${redaction.rule_id}`;
        const current = redactionCounts.get(key) ?? {
          ...redaction,
          count: 0
        };
        current.count += redaction.count;
        redactionCounts.set(key, current);
      }
    };

    while (
      position < selected.length &&
      pageItems < MAX_PROJECT_PAGE_ITEMS
    ) {
      const entry = selected[position];
      if (entry.diagnostic) {
        const citationIndex = addCitation(entry.citation);
        diagnostics.push({
          ...entry.diagnostic,
          citation_index: citationIndex
        });
      } else {
        const line = entry.text ?? `${JSON.stringify(entry.value)}\n`;
        const lineBytes = Buffer.byteLength(line, "utf8");
        if (lineBytes > maxBytes) {
          const citationIndex = addCitation(entry.citation);
          omitted = true;
          diagnostics.push({
            code: "EG-PROJECT-BUDGET-001",
            message:
              "A projected record exceeded the page budget and was omitted.",
            citation_index: citationIndex
          });
        } else if (appliedBytes + lineBytes > maxBytes) {
          break;
        } else {
          const citationIndex = addCitation(entry.citation);
          chunks.push(line);
          recordCitations.push(citationIndex);
          appliedBytes += lineBytes;
        }
      }
      addRedactions(entry.redactions ?? []);
      position += 1;
      pageItems += 1;
    }
    if (pageItems > 0) addRedactions(commonRedactions);

    const moreAvailable = position < selected.length;
    const partial = moreAvailable || omitted;
    const viewId = randomId("view");
    const continuation = moreAvailable
      ? this.createCursor(
          artifact.artifactId,
          viewId,
          position,
          maxBytes,
          advancing,
          {
            project: {
              format,
              fields,
              columns,
              filter,
              heading,
              sliceOffset,
              sliceLimit,
              maxTokens
            }
          }
        )
      : null;
    const content = chunks.join("");
    const emittedDigest = digest(Buffer.from(content, "utf8"));
    const view = {
      schema_version: "1.0.0",
      view_id: viewId,
      artifact_id: artifact.artifactId,
      session_id: this.sessionId,
      status: partial ? "partial_view" : "complete",
      media_type: projection.mediaType,
      content,
      budget: {
        max_tokens: maxTokens,
        max_bytes: maxBytes,
        applied_tokens: Math.ceil(appliedBytes / 4),
        applied_bytes: appliedBytes,
        overflow: partial ? "projected" : "none"
      },
      token_count: tokenCount(appliedBytes, emittedDigest),
      citations,
      record_citations: recordCitations,
      redactions: [...redactionCounts.values()],
      diagnostics,
      retrieval: {
        more_available: moreAvailable,
        operations: moreAvailable
          ? ["fetch", "project", "search"]
          : ["project", "search"]
      },
      integrity: {}
    };
    if (partial) {
      view.estimated_raw_token_count = tokenCount(
        artifact.byteLength,
        artifact.sourceDigest
      );
    }
    if (continuation) {
      view.retrieval.cursor = continuation.cursor;
      view.retrieval.expires_at = new Date(
        continuation.expiresAt
      ).toISOString();
    }
    return finalizeView(
      view,
      artifact,
      format === "json" || format === "jsonl"
        ? JSON_PROJECTION_VERSION
        : DOCUMENT_PROJECTION_VERSION
    );
  }

  createSearchView(
    artifact,
    { query, contextLines, maxTokens, offset },
    advancing = false
  ) {
    if (artifact.opaque) {
      return this.createUnavailableView(
        artifact,
        maxTokens * 4,
        SEARCH_PROJECTION_VERSION
      );
    }
    const raw = this.cas.readRange(
      artifact.sourceDigest,
      0,
      artifact.byteLength,
      artifact.byteLength
    );
    const text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > text.length) {
      throw new InvalidCursorError();
    }

    const match = text.indexOf(query, offset);
    const maxBytes = maxTokens * 4;
    let content = "";
    let citations = [];
    let redactions = [];
    let nextMatch = -1;
    let windowClipped = false;

    if (match !== -1) {
      const offsets = utf8ByteOffsets(text);
      const starts = lineStarts(text);
      const firstLine = lineAt(starts, match);
      const lastLine = lineAt(starts, match + query.length - 1);
      const firstContextLine = Math.max(0, firstLine - contextLines);
      const afterContextLine = Math.min(
        starts.length,
        lastLine + contextLines + 1
      );
      const matchStart = offsets[match];
      const matchEnd = offsets[match + query.length];
      const requestedStart = offsets[starts[firstContextLine]];
      const requestedEnd = offsets[
        afterContextLine < starts.length
          ? starts[afterContextLine]
          : text.length
      ];
      const window = boundedWindow(
        raw,
        requestedStart,
        requestedEnd,
        matchStart,
        matchEnd,
        maxBytes
      );
      windowClipped =
        window.start !== requestedStart || window.end !== requestedEnd;
      const rendered = renderRedactedPage(
        artifact,
        raw.subarray(window.start, window.end),
        window.start,
        window.end
      );
      content = rendered.content;
      redactions = rendered.redactions;
      citations = [
        {
          artifact_id: artifact.artifactId,
          source_digest: artifact.sourceDigest,
          byte_start: window.start,
          byte_end: window.end
        }
      ];

      const visibleEnd = stringIndexAtByte(offsets, window.end);
      nextMatch = text.indexOf(query, match + 1);
      while (
        nextMatch !== -1 &&
        nextMatch + query.length <= visibleEnd
      ) {
        nextMatch = text.indexOf(query, nextMatch + 1);
      }
    }

    const emittedBytes = Buffer.from(content, "utf8");
    const moreAvailable = nextMatch !== -1;
    const partial = moreAvailable || windowClipped;
    const viewId = randomId("view");
    const continuation = moreAvailable
      ? this.createCursor(
          artifact.artifactId,
          viewId,
          nextMatch,
          maxBytes,
          advancing,
          {
            search: {
              query,
              contextLines,
              maxTokens
            }
          }
        )
      : null;
    const view = {
      schema_version: "1.0.0",
      view_id: viewId,
      artifact_id: artifact.artifactId,
      session_id: this.sessionId,
      status: partial ? "partial_view" : "complete",
      media_type: artifact.mediaType,
      content,
      budget: {
        max_tokens: maxTokens,
        max_bytes: maxBytes,
        applied_tokens: Math.ceil(emittedBytes.length / 4),
        applied_bytes: emittedBytes.length,
        overflow: partial ? "projected" : "none"
      },
      token_count: tokenCount(emittedBytes.length, digest(emittedBytes)),
      citations,
      redactions,
      diagnostics: [
        {
          code: "EG-SEARCH-001",
          message:
            "Deterministic case-sensitive literal search v1 was applied."
        },
        ...artifactDiagnostics(artifact),
        ...(windowClipped
          ? [
              {
                code: "EG-VIEW-001",
                message:
                  "The context window was clipped to the search byte budget."
              }
            ]
          : [])
      ],
      retrieval: {
        more_available: moreAvailable,
        operations: moreAvailable
          ? ["fetch", "project", "search"]
          : ["project", "search"]
      },
      integrity: {}
    };
    if (partial) {
      view.estimated_raw_token_count = tokenCount(
        artifact.byteLength,
        artifact.sourceDigest
      );
    }
    if (moreAvailable) {
      view.retrieval.cursor = continuation.cursor;
      view.retrieval.expires_at = new Date(
        continuation.expiresAt
      ).toISOString();
    }
    return finalizeView(view, artifact, SEARCH_PROJECTION_VERSION);
  }

  createView(
    artifact,
    start,
    advancing = false,
    maxBytes = this.pageBytes
  ) {
    if (artifact.opaque) {
      return this.createUnavailableView(
        artifact,
        maxBytes,
        PROJECTION_VERSION
      );
    }
    const probeEnd = Math.min(
      start + maxBytes + 1,
      artifact.byteLength
    );
    const probe = this.cas.readRange(
      artifact.sourceDigest,
      start,
      probeEnd,
      artifact.byteLength
    );
    const end = start + pageEnd(probe, 0, maxBytes);
    if (end < start || (end === start && start < artifact.byteLength)) {
      throw new Error("Context View paging made no progress");
    }

    const page = probe.subarray(0, end - start);
    const rendered = renderRedactedPage(artifact, page, start, end);
    const emittedBytes = Buffer.from(rendered.content, "utf8");
    const emittedDigest = digest(emittedBytes);
    const complete = start === 0 && end === artifact.byteLength;
    const moreAvailable = end < artifact.byteLength;
    const viewId = randomId("view");
    const continuation = moreAvailable
      ? this.createCursor(
          artifact.artifactId,
          viewId,
          end,
          maxBytes,
          advancing
        )
      : null;

    const view = {
      schema_version: "1.0.0",
      view_id: viewId,
      artifact_id: artifact.artifactId,
      session_id: this.sessionId,
      status: complete ? "complete" : "partial_view",
      media_type: artifact.mediaType,
      content: rendered.content,
      budget: {
        max_tokens: Math.ceil(maxBytes / 4),
        max_bytes: maxBytes,
        applied_tokens: Math.ceil(emittedBytes.length / 4),
        applied_bytes: emittedBytes.length,
        overflow: complete ? "none" : "paged"
      },
      token_count: tokenCount(emittedBytes.length, emittedDigest),
      citations: [
        {
          artifact_id: artifact.artifactId,
          source_digest: artifact.sourceDigest,
          byte_start: start,
          byte_end: end
        }
      ],
      redactions: rendered.redactions,
      diagnostics: artifactDiagnostics(artifact),
      retrieval: {
        more_available: moreAvailable,
        operations: moreAvailable
          ? ["fetch", "project", "search"]
          : ["project", "search"]
      },
      integrity: {}
    };

    if (!complete) {
      view.estimated_raw_token_count = tokenCount(
        artifact.byteLength,
        artifact.sourceDigest
      );
    }
    if (continuation) {
      view.retrieval.cursor = continuation.cursor;
      view.retrieval.expires_at = new Date(continuation.expiresAt).toISOString();
    }
    return finalizeView(view, artifact, PROJECTION_VERSION);
  }
}
