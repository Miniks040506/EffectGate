import { createHash, randomBytes } from "node:crypto";

import { FilesystemCas } from "./filesystem-cas.mjs";

export const CONTEXT_PAGE_BYTES = 4096;
export const CONTEXT_MAX_ARTIFACT_BYTES = 1024 * 1024;
export const CONTEXT_STORE_BYTES = 4 * 1024 * 1024;
export const CONTEXT_CURSOR_TTL_MS = 10 * 60 * 1000;

const TOKEN_COUNTER_ID = "utf8-bytes-ceil-div-4";
const PROJECTION_VERSION = "text-byte-page-redact-v1";
const MAX_SCHEMA_CONTENT_LENGTH = 262144;
const MAX_REDACTION_SPANS = 4096;
const REDACTION_MARKER = "[REDACTED]";

const REDACTION_RULESET_VERSION = "preview-v1";
const REDACTION_RULES = Object.freeze([
  {
    ruleId: "secret-assignment-v1",
    class: "secret",
    pattern:
      /\b(?:api[_-]?key|access[_-]?token|password|secret)\s*[:=]\s*["']?([^\s"',;}\]]{16,})/dgi,
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

function isUnicodeScalarText(text) {
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function pageEnd(bytes, start, maxBytes) {
  let end = Math.min(start + maxBytes, bytes.length);
  while (end < bytes.length && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return end;
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
        throw new RangeError("artifact exceeds the redaction span limit");
      }
    }
  }
  return spans.sort(
    (left, right) =>
      left.byteStart - right.byteStart || right.byteEnd - left.byteEnd
  );
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
    this.maxCursors = maxCursors;
    this.cursorTtlMs = cursorTtlMs;
    this.now = now;
    this.cas = new FilesystemCas({
      directory: casDirectory,
      maxObjectBytes: maxArtifactBytes
    });
    this.sessionId = randomId("sess");
    this.artifacts = new Map();
    this.cursors = new Map();
    this.storedBytes = 0;
  }

  ingest(text, mediaType = "text/plain") {
    if (typeof text !== "string" || typeof mediaType !== "string") {
      throw new TypeError("text and mediaType must be strings");
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
      throw new RangeError("artifact exceeds the Context Store capacity");
    }

    const sourceDigest = digest(text);
    const artifactId = `art_${sourceDigest.slice("sha256:".length)}`;
    let artifact = this.artifacts.get(artifactId);

    if (artifact) {
      this.artifacts.delete(artifactId);
      this.artifacts.set(artifactId, artifact);
    } else {
      const redactionSpans = scanRedactions(text);
      this.pruneExpiredCursors();
      while (
        this.artifacts.size >= this.maxArtifacts ||
        this.storedBytes + byteLength > this.maxStoreBytes
      ) {
        const oldest = [...this.artifacts.keys()].find(
          (candidate) => !this.isPinned(candidate)
        );
        if (oldest === undefined) {
          throw new RangeError("artifact exceeds the Context Store capacity");
        }
        this.dropArtifact(oldest);
      }
      const stored = this.cas.put(utf8Chunks(text), {
        expectedBytes: byteLength,
        expectedDigest: sourceDigest
      });
      artifact = {
        artifactId,
        sourceDigest,
        byteLength: stored.bytes,
        mediaType,
        redactionSpans
      };
      this.artifacts.set(artifactId, artifact);
      this.storedBytes += stored.bytes;
    }

    return this.createView(artifact, 0);
  }

  fetch(cursor) {
    if (typeof cursor !== "string") throw new InvalidCursorError();
    const position = this.cursors.get(cursor);
    if (!position) throw new InvalidCursorError();
    if (position.expiresAt <= this.now()) {
      this.cursors.delete(cursor);
      throw new InvalidCursorError();
    }
    if (position.view) return position.view;

    const artifact = this.artifacts.get(position.artifactId);
    if (!artifact) throw new InvalidCursorError();
    this.artifacts.delete(artifact.artifactId);
    this.artifacts.set(artifact.artifactId, artifact);
    const view = this.createView(artifact, position.offset, true);
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
    this.cursors.clear();
    this.artifacts.clear();
    this.storedBytes = 0;
    this.cas.close();
  }

  pruneExpiredCursors() {
    const currentTime = this.now();
    for (const [cursor, position] of this.cursors) {
      if (position.expiresAt <= currentTime) this.cursors.delete(cursor);
    }
  }

  isPinned(artifactId) {
    return [...this.cursors.values()].some(
      (position) =>
        position.artifactId === artifactId && position.view === undefined
    );
  }

  createCursor(artifactId, offset, advancing) {
    const currentTime = this.now();
    this.pruneExpiredCursors();
    const limit = advancing ? this.maxCursors : this.maxCursors - 1;
    while (this.cursors.size >= limit) {
      const replay = [...this.cursors].find(([, position]) => position.view);
      if (!replay) {
        throw new RangeError("retrieval cursor capacity is full");
      }
      this.cursors.delete(replay[0]);
    }

    let cursor;
    do {
      cursor = randomId("cur", 24);
    } while (this.cursors.has(cursor));
    const expiresAt = currentTime + this.cursorTtlMs;
    this.cursors.set(cursor, { artifactId, offset, expiresAt });
    return { cursor, expiresAt };
  }

  createView(artifact, start, advancing = false) {
    const probeEnd = Math.min(
      start + this.pageBytes + 1,
      artifact.byteLength
    );
    const probe = this.cas.readRange(
      artifact.sourceDigest,
      start,
      probeEnd,
      artifact.byteLength
    );
    const end = start + pageEnd(probe, 0, this.pageBytes);
    if (end < start || (end === start && start < artifact.byteLength)) {
      throw new Error("Context View paging made no progress");
    }

    const page = probe.subarray(0, end - start);
    const rendered = renderRedactedPage(artifact, page, start, end);
    const emittedBytes = Buffer.from(rendered.content, "utf8");
    const emittedDigest = digest(emittedBytes);
    const complete = start === 0 && end === artifact.byteLength;
    const moreAvailable = end < artifact.byteLength;
    const continuation = moreAvailable
      ? this.createCursor(artifact.artifactId, end, advancing)
      : null;

    const view = {
      schema_version: "1.0.0",
      view_id: randomId("view"),
      artifact_id: artifact.artifactId,
      session_id: this.sessionId,
      status: complete ? "complete" : "partial_view",
      media_type: artifact.mediaType,
      content: rendered.content,
      budget: {
        max_tokens: this.pageBytes,
        max_bytes: this.pageBytes,
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
      diagnostics: [
        {
          code: "EG-REDACT-001",
          message: `Deterministic redaction ruleset ${REDACTION_RULESET_VERSION} was applied.`
        }
      ],
      retrieval: {
        more_available: moreAvailable,
        operations: moreAvailable ? ["fetch"] : []
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
    view.integrity = {
      artifact_digest: artifact.sourceDigest,
      view_digest: digest(
        Buffer.from(
          JSON.stringify({
            ...view,
            integrity: {
              artifact_digest: artifact.sourceDigest,
              projection_version: PROJECTION_VERSION
            }
          }),
          "utf8"
        )
      ),
      projection_version: PROJECTION_VERSION
    };
    return view;
  }
}
