import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  MAX_FRAME_BYTES,
  readBoundedJsonLines,
  validateResponse
} from "../src/proxy/jsonl-rpc.mjs";
import {
  isSafeReadTool,
  isValidToolContract
} from "../src/proxy/mcp-contract.mjs";

const FUZZ_SEED = 0x45474631;
const MUTATION_CASES = 512;

function seededRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return state >>> 0;
  };
}

function randomFrame(next, length) {
  const frame = Buffer.allocUnsafe(length);
  for (let index = 0; index < length; index += 1) {
    const byte = next() & 0xff;
    frame[index] = byte === 0x0a ? 0x00 : byte;
  }
  return frame;
}

function parseInRandomChunks(input, next) {
  return new Promise((resolve, reject) => {
    const stream = new PassThrough();
    const messages = [];
    const errors = [];
    stream.on("error", reject);
    readBoundedJsonLines(stream, {
      onMessage: (message) => messages.push(message),
      onError: (error) => errors.push(error),
      onEnd: () => resolve({ messages, errors })
    });

    let offset = 0;
    while (offset < input.length) {
      const size = 1 + (next() % 4096);
      stream.write(input.subarray(offset, offset + size));
      offset += size;
    }
    stream.end();
  });
}

test("seeded JSONL and MCP boundary fuzzing fails closed and recovers", async () => {
  const next = seededRandom(FUZZ_SEED);
  const frames = [];
  for (let index = 0; index < MUTATION_CASES; index += 1) {
    frames.push(
      randomFrame(next, 1 + (next() % 512)),
      Buffer.from("\n"),
      Buffer.from(`${JSON.stringify({ effectgate_fuzz_probe: index })}${
        index % 2 === 0 ? "\n" : "\r\n"
      }`)
    );
  }
  frames.push(randomFrame(next, 31));

  const mutated = await parseInRandomChunks(Buffer.concat(frames), next);
  assert.deepEqual(
    mutated.messages
      .filter((message) =>
        message !== null &&
        typeof message === "object" &&
        Number.isInteger(message.effectgate_fuzz_probe)
      )
      .map((message) => message.effectgate_fuzz_probe),
    Array.from({ length: MUTATION_CASES }, (_, index) => index)
  );
  assert.ok(mutated.errors.length > 0);
  assert.ok(mutated.errors.every((error) => error === "invalid_json"));

  for (const message of mutated.messages) {
    assert.equal(typeof validateResponse(message), "boolean");
    assert.equal(typeof isValidToolContract(message), "boolean");
    const safe = isSafeReadTool(message);
    assert.equal(typeof safe, "boolean");
    if (safe) {
      assert.equal(message.annotations.readOnlyHint, true);
      assert.equal(message.annotations.destructiveHint, false);
      assert.equal(message.annotations.idempotentHint, true);
      assert.equal(message.annotations.openWorldHint, false);
    }
  }

  const response = { jsonrpc: "2.0", id: 7, result: {} };
  const oversized = await parseInRandomChunks(Buffer.concat([
    Buffer.alloc(MAX_FRAME_BYTES + 1, 0x78),
    Buffer.from(`\n${JSON.stringify(response)}\n`)
  ]), next);
  assert.deepEqual(oversized.errors, ["frame_too_large"]);
  assert.deepEqual(oversized.messages, [response]);
  assert.equal(validateResponse(oversized.messages[0]), true);

  process.stdout.write(`${JSON.stringify({
    kind: "effectgate_security_fuzz_evidence",
    seed: `0x${FUZZ_SEED.toString(16)}`,
    mutation_cases: MUTATION_CASES,
    oversized_frames: 1,
    targets: ["jsonl_framing", "rpc_response", "mcp_tool_contract"]
  })}\n`);
});
