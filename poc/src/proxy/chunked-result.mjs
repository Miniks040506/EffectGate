import { createHash } from "node:crypto";

import { FrameTooLargeError, MAX_FRAME_BYTES } from "./jsonl-rpc.mjs";

export const CHUNKED_RESULT_METHOD =
  "notifications/effectgate/result_chunk";
export const CHUNKED_RESULT_META = "dev.effectgate/chunked-result";
export const CHUNKED_RESULT_BYTES = 512 * 1024;

const DIGEST = /^sha256:[a-f0-9]{64}$/u;

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function descriptor(result) {
  if (
    result === null ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).length !== 1 ||
    result._meta === null ||
    typeof result._meta !== "object" ||
    Array.isArray(result._meta) ||
    Object.keys(result._meta).length !== 1
  ) {
    return;
  }
  return result._meta[CHUNKED_RESULT_META];
}

export function boundedResponseMessages(message, maxBytes) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new TypeError("maxBytes must be a positive integer");
  }
  const frame = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(frame, "utf8") <= MAX_FRAME_BYTES) return [message];
  if (
    !Object.hasOwn(message ?? {}, "result") ||
    message.result === null ||
    typeof message.result !== "object" ||
    !Array.isArray(message.result.content)
  ) {
    throw new FrameTooLargeError();
  }

  const payload = Buffer.from(JSON.stringify(message.result), "utf8");
  if (payload.length > maxBytes) throw new FrameTooLargeError();
  const chunks = Math.ceil(payload.length / CHUNKED_RESULT_BYTES);
  const manifest = Object.freeze({
    version: "1.0.0",
    encoding: "base64",
    chunks,
    bytes: payload.length,
    digest: sha256(payload)
  });

  return (function* messages() {
    for (let sequence = 0; sequence < chunks; sequence += 1) {
      const start = sequence * CHUNKED_RESULT_BYTES;
      yield {
        jsonrpc: "2.0",
        method: CHUNKED_RESULT_METHOD,
        params: {
          request_id: message.id,
          sequence,
          data: payload
            .subarray(start, start + CHUNKED_RESULT_BYTES)
            .toString("base64")
        }
      };
    }
    yield {
      jsonrpc: "2.0",
      id: message.id,
      result: { _meta: { [CHUNKED_RESULT_META]: manifest } }
    };
  })();
}

export class ChunkedResultReceiver {
  constructor(requestId, maxBytes) {
    if (
      typeof requestId !== "string" ||
      !Number.isSafeInteger(maxBytes) ||
      maxBytes < 1
    ) {
      throw new TypeError("invalid chunked-result receiver configuration");
    }
    this.requestId = requestId;
    this.maxBytes = maxBytes;
    this.chunks = [];
    this.bytes = 0;
  }

  get started() {
    return this.chunks.length > 0;
  }

  accept(message) {
    const params = message?.params;
    if (
      message?.jsonrpc !== "2.0" ||
      message.method !== CHUNKED_RESULT_METHOD ||
      params === null ||
      typeof params !== "object" ||
      Array.isArray(params) ||
      Object.keys(params).length !== 3 ||
      params.request_id !== this.requestId ||
      params.sequence !== this.chunks.length ||
      typeof params.data !== "string" ||
      !/^[A-Za-z0-9+/]+={0,2}$/u.test(params.data)
    ) {
      throw new TypeError("invalid chunked-result frame");
    }
    const chunk = Buffer.from(params.data, "base64");
    if (
      chunk.length < 1 ||
      chunk.length > CHUNKED_RESULT_BYTES ||
      chunk.toString("base64") !== params.data ||
      this.bytes + chunk.length > this.maxBytes
    ) {
      throw new RangeError("chunked result exceeds its transport limit");
    }
    this.chunks.push(chunk);
    this.bytes += chunk.length;
  }

  finish(result) {
    const manifest = descriptor(result);
    if (manifest === undefined) {
      if (this.started) throw new TypeError("chunked result is incomplete");
      return result;
    }
    if (
      manifest === null ||
      typeof manifest !== "object" ||
      Array.isArray(manifest) ||
      Object.keys(manifest).length !== 5 ||
      manifest.version !== "1.0.0" ||
      manifest.encoding !== "base64" ||
      manifest.chunks !== this.chunks.length ||
      manifest.bytes !== this.bytes ||
      typeof manifest.digest !== "string" ||
      !DIGEST.test(manifest.digest)
    ) {
      throw new TypeError("invalid chunked-result manifest");
    }
    const payload = Buffer.concat(this.chunks, this.bytes);
    if (sha256(payload) !== manifest.digest) {
      throw new TypeError("chunked-result digest mismatch");
    }
    const text = new TextDecoder("utf-8", { fatal: true }).decode(payload);
    return JSON.parse(text);
  }
}
