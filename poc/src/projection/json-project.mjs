export const CONTEXT_PROJECT_MAX_POINTER_LENGTH = 256;
export const CONTEXT_PROJECT_MAX_FIELDS = 16;
export const CONTEXT_PROJECT_MAX_OFFSET = 1024 * 1024;
export const CONTEXT_PROJECT_MAX_LIMIT = 1000;
export const CONTEXT_PROJECT_MIN_TOKENS = 64;
export const CONTEXT_PROJECT_MAX_TOKENS = 1024;

export class InvalidJsonProjectionError extends Error {
  constructor() {
    super("invalid JSON projection source");
    this.name = "InvalidJsonProjectionError";
  }
}

export function isUnicodeScalarText(text) {
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

export function isValidJsonPointer(pointer) {
  return (
    typeof pointer === "string" &&
    pointer.length <= CONTEXT_PROJECT_MAX_POINTER_LENGTH * 2 &&
    isUnicodeScalarText(pointer) &&
    [...pointer].length <= CONTEXT_PROJECT_MAX_POINTER_LENGTH &&
    Buffer.byteLength(pointer, "utf8") <=
      CONTEXT_PROJECT_MAX_POINTER_LENGTH * 4 &&
    (pointer === "" ||
      (pointer.startsWith("/") && !/~(?![01])/u.test(pointer)))
  );
}

export function isValidProjectionScalar(value) {
  return (
    value === null ||
    typeof value === "boolean" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" &&
      value.length <= CONTEXT_PROJECT_MAX_POINTER_LENGTH * 2 &&
      isUnicodeScalarText(value) &&
      [...value].length <= CONTEXT_PROJECT_MAX_POINTER_LENGTH &&
      Buffer.byteLength(value, "utf8") <=
        CONTEXT_PROJECT_MAX_POINTER_LENGTH * 4)
  );
}

function resolveJsonPointer(value, pointer) {
  if (pointer === "") return { found: true, value };
  for (const encoded of pointer.slice(1).split("/")) {
    const token = encoded.replaceAll("~1", "/").replaceAll("~0", "~");
    if (Array.isArray(value)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token)) return { found: false };
      const index = Number(token);
      if (!Number.isSafeInteger(index) || index >= value.length) {
        return { found: false };
      }
      value = value[index];
    } else if (
      value !== null &&
      typeof value === "object" &&
      Object.hasOwn(value, token)
    ) {
      value = value[token];
    } else {
      return { found: false };
    }
  }
  return { found: true, value };
}

function selectRecord(source, visible, fields, filter) {
  if (filter) {
    const candidate = resolveJsonPointer(source, filter.pointer);
    if (!candidate.found || candidate.value !== filter.equals) return;
  }
  if (fields.length === 0) return visible;

  const selected = {};
  for (const pointer of fields) {
    const candidate = resolveJsonPointer(visible, pointer);
    if (candidate.found) selected[pointer] = candidate.value;
  }
  return selected;
}

export function buildJsonProjectionEntries({
  artifact,
  raw,
  text,
  format,
  fields,
  filter,
  starts,
  offsets,
  render
}) {
  const entries = [];
  let commonRedactions = [];

  if (format === "json") {
    const rendered = render(0, artifact.byteLength);
    let source;
    let visible;
    try {
      source = JSON.parse(text);
      visible =
        rendered.redactions.length === 0
          ? source
          : JSON.parse(rendered.content);
    } catch {
      throw new InvalidJsonProjectionError();
    }

    const sourceItems = Array.isArray(source) ? source : [source];
    const visibleItems = Array.isArray(source) ? visible : [visible];
    if (
      !Array.isArray(visibleItems) ||
      sourceItems.length !== visibleItems.length
    ) {
      throw new InvalidJsonProjectionError();
    }
    commonRedactions = rendered.redactions;
    for (let index = 0; index < sourceItems.length; index += 1) {
      const value = selectRecord(
        sourceItems[index],
        visibleItems[index],
        fields,
        filter
      );
      if (value !== undefined) {
        entries.push({
          value,
          citation: {
            artifact_id: artifact.artifactId,
            source_digest: artifact.sourceDigest,
            byte_start: 0,
            byte_end: artifact.byteLength
          }
        });
      }
    }
    return {
      entries,
      commonRedactions,
      mediaType: "application/x-ndjson",
      diagnostic: {
        code: "EG-PROJECT-001",
        message:
          "Deterministic JSON Pointer, scalar equality, and slice projection v1 was applied."
      }
    };
  }

  if (!Buffer.isBuffer(raw)) throw new InvalidJsonProjectionError();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  for (let line = 0, byteStart = 0; byteStart < raw.length; line += 1) {
    const newline = raw.indexOf(0x0a, byteStart);
    const afterLine = newline === -1 ? raw.length : newline + 1;
    let contentEnd = newline === -1 ? raw.length : newline;
    if (raw[contentEnd - 1] === 0x0d) contentEnd -= 1;
    const citation = {
      artifact_id: artifact.artifactId,
      source_digest: artifact.sourceDigest,
      byte_start: byteStart,
      byte_end: afterLine
    };
    const rendered = render(byteStart, contentEnd);
    let source;
    let visible;
    try {
      source = JSON.parse(decoder.decode(raw.subarray(byteStart, contentEnd)));
      visible =
        rendered.redactions.length === 0
          ? source
          : JSON.parse(rendered.content);
    } catch {
      entries.push({
        diagnostic: {
          code: "EG-PROJECT-JSONL-001",
          message: `JSONL line ${line + 1} is malformed.`
        },
        citation,
        redactions: rendered.redactions
      });
      byteStart = afterLine;
      continue;
    }
    const value = selectRecord(source, visible, fields, filter);
    if (value !== undefined) {
      entries.push({ value, citation, redactions: rendered.redactions });
    }
    byteStart = afterLine;
  }
  return {
    entries,
    commonRedactions,
    mediaType: "application/x-ndjson",
    diagnostic: {
      code: "EG-PROJECT-001",
      message:
        "Deterministic JSON Pointer, scalar equality, and slice projection v1 was applied."
    }
  };
}
