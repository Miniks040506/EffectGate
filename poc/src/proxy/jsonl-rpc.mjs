import process from "node:process";

export const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_ID_BYTES = 128;

export class FrameTooLargeError extends Error {}

export function writeMessage(stream, message) {
  const frame = `${JSON.stringify(message)}\n`;
  if (Buffer.byteLength(frame) > MAX_FRAME_BYTES) {
    throw new FrameTooLargeError();
  }
  return stream.write(frame);
}

export function validateResponse(message) {
  const hasResult = Object.hasOwn(message ?? {}, "result");
  const hasError = Object.hasOwn(message ?? {}, "error");
  return (
    message !== null &&
    typeof message === "object" &&
    !Array.isArray(message) &&
    message.jsonrpc === "2.0" &&
    ((typeof message.id === "string" &&
      Buffer.byteLength(message.id) <= MAX_ID_BYTES) ||
      (typeof message.id === "number" && Number.isSafeInteger(message.id))) &&
    hasResult !== hasError &&
    (!hasError ||
      (message.error !== null &&
        typeof message.error === "object" &&
        !Array.isArray(message.error)))
  );
}

export function readBoundedJsonLines(
  stream,
  { onMessage, onError, onEnd }
) {
  let buffered = Buffer.alloc(0);
  let discarding = false;

  stream.on("data", (incoming) => {
    let chunk = Buffer.isBuffer(incoming) ? incoming : Buffer.from(incoming);

    while (chunk.length > 0) {
      const newline = chunk.indexOf(0x0a);
      const segment = newline === -1 ? chunk : chunk.subarray(0, newline);
      chunk = newline === -1 ? Buffer.alloc(0) : chunk.subarray(newline + 1);

      if (discarding) {
        if (newline !== -1) discarding = false;
        continue;
      }

      if (buffered.length + segment.length > MAX_FRAME_BYTES) {
        buffered = Buffer.alloc(0);
        discarding = newline === -1;
        onError("frame_too_large");
        continue;
      }

      buffered = Buffer.concat([buffered, segment]);
      if (newline === -1) continue;

      const line =
        buffered.at(-1) === 0x0d
          ? buffered.subarray(0, buffered.length - 1)
          : buffered;
      buffered = Buffer.alloc(0);
      if (line.length === 0) continue;

      try {
        const text = new TextDecoder("utf-8", { fatal: true }).decode(line);
        onMessage(JSON.parse(text));
      } catch {
        onError("invalid_json");
      }
    }
  });

  stream.on("end", () => {
    if (buffered.length > 0 && !discarding) onError("invalid_json");
    onEnd?.();
  });
}

export function backendEnvironment() {
  const allowed = [
    "PATH",
    "Path",
    "PATHEXT",
    "SystemRoot",
    "SYSTEMROOT",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP"
  ];
  return Object.fromEntries(
    allowed
      .filter((name) => process.env[name] !== undefined)
      .map((name) => [name, process.env[name]])
  );
}
