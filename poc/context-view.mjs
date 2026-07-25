import { createHash, randomBytes } from "node:crypto";

export const CONTEXT_PAGE_BYTES = 4096;
export const CONTEXT_MAX_ARTIFACT_BYTES = 1024 * 1024;
export const CONTEXT_STORE_BYTES = 4 * 1024 * 1024;
export const CONTEXT_CURSOR_TTL_MS = 10 * 60 * 1000;

const TOKEN_COUNTER_ID = "utf8-bytes-ceil-div-4";
const PROJECTION_VERSION = "text-byte-page-v1";
const MAX_SCHEMA_CONTENT_LENGTH = 262144;

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

export class ContextStore {
  constructor({
    pageBytes = CONTEXT_PAGE_BYTES,
    maxArtifactBytes = CONTEXT_MAX_ARTIFACT_BYTES,
    maxStoreBytes = CONTEXT_STORE_BYTES,
    maxArtifacts = 16,
    maxCursors = 64,
    cursorTtlMs = CONTEXT_CURSOR_TTL_MS,
    now = Date.now
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

    const bytes = Buffer.from(text, "utf8");
    if (
      bytes.length > this.maxArtifactBytes ||
      bytes.length > this.maxStoreBytes
    ) {
      throw new RangeError("artifact exceeds the Context Store capacity");
    }

    const sourceDigest = digest(bytes);
    const artifactId = `art_${sourceDigest.slice("sha256:".length)}`;
    let artifact = this.artifacts.get(artifactId);

    if (artifact) {
      if (!artifact.bytes.equals(bytes)) {
        throw new Error("artifact digest collision");
      }
      this.artifacts.delete(artifactId);
      this.artifacts.set(artifactId, artifact);
    } else {
      this.pruneExpiredCursors();
      while (
        this.artifacts.size >= this.maxArtifacts ||
        this.storedBytes + bytes.length > this.maxStoreBytes
      ) {
        const oldest = [...this.artifacts.keys()].find(
          (candidate) => !this.isPinned(candidate)
        );
        if (oldest === undefined) {
          throw new RangeError("artifact exceeds the Context Store capacity");
        }
        this.dropArtifact(oldest);
      }
      artifact = { artifactId, sourceDigest, bytes, mediaType };
      this.artifacts.set(artifactId, artifact);
      this.storedBytes += bytes.length;
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
    this.artifacts.delete(artifactId);
    this.storedBytes -= artifact.bytes.length;
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
    const end = pageEnd(artifact.bytes, start, this.pageBytes);
    if (end < start || (end === start && start < artifact.bytes.length)) {
      throw new Error("Context View paging made no progress");
    }

    const page = artifact.bytes.subarray(start, end);
    const pageDigest = digest(page);
    const complete = start === 0 && end === artifact.bytes.length;
    const moreAvailable = end < artifact.bytes.length;
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
      content: new TextDecoder("utf-8", { fatal: true }).decode(page),
      budget: {
        max_tokens: this.pageBytes,
        max_bytes: this.pageBytes,
        applied_tokens: Math.ceil(page.length / 4),
        applied_bytes: page.length,
        overflow: complete ? "none" : "paged"
      },
      token_count: tokenCount(page.length, pageDigest),
      citations: [
        {
          artifact_id: artifact.artifactId,
          source_digest: artifact.sourceDigest,
          byte_start: start,
          byte_end: end
        }
      ],
      redactions: [],
      diagnostics: [
        {
          code: "EG-VIEW-001",
          message:
            "Redaction was not performed; this preview accepts only the " +
            "secret-free bundled fixture."
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
        artifact.bytes.length,
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
