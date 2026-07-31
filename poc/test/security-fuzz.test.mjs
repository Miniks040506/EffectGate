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
import {
  compileEffectIntent,
  verifyEffectIntent
} from "../src/policy/effect-intent.mjs";
import {
  compilePolicy,
  evaluatePolicy
} from "../src/policy/policy-compiler.mjs";

const FUZZ_SEED = 0x45474631;
const MUTATION_CASES = 512;
const EFFECT_FUZZ_SEED = 0x45474632;
const EFFECT_MUTATION_CASES = 512;
const ARGUMENT_CASES = 256;
const POLICY_MUTATION_CASES = 256;
const digest = (character) => `sha256:${character.repeat(64)}`;

const EFFECT_BINDING = Object.freeze({
  skill_id: "document-editor",
  skill_digest: digest("a"),
  phase: "modify",
  phase_revision: 2,
  capsule_digest: digest("b"),
  capability_id: "filesystem.apply_patch",
  capability_revision: "patch-v1",
  effect_class: "mutate_reversible"
});
const ADMISSION = Object.freeze({
  schema_version: "1.0.0",
  transaction_id: "fuzz-transaction",
  ...EFFECT_BINDING
});
const BINDING_KEYS = Object.freeze(Object.keys(EFFECT_BINDING));
const MUTATED_VALUES = Object.freeze([
  null, undefined, true, false, 0, -1, 1.5, Number.NaN,
  Number.POSITIVE_INFINITY, "", "unknown", "../escape", "\0", [], {}
]);

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

function randomJson(next, depth = 0) {
  if (depth >= 4 || next() % 3 === 0) {
    const scalars = [
      null,
      next() % 2 === 0,
      (next() % 2001) - 1000,
      `fuzz-secret-${next().toString(16)}`,
      "cafe\u0301"
    ];
    return scalars[next() % scalars.length];
  }
  if (next() % 2 === 0) {
    return Array.from(
      { length: next() % 5 },
      () => randomJson(next, depth + 1)
    );
  }
  return Object.fromEntries(
    Array.from(
      { length: next() % 5 },
      (_, index) => [`key_${index}`, randomJson(next, depth + 1)]
    )
  );
}

function effectIntentInput({
  admission = ADMISSION,
  policyDecision,
  arguments: argumentValue = {}
} = {}) {
  return {
    principalId: "principal-local",
    clientId: "fuzz-client",
    sessionId: "fuzz-session",
    admission,
    policyDecision,
    arguments: argumentValue,
    resourceScope: {
      kind: "exact",
      value: "repo:owner/name/path:docs/guide.md"
    },
    disclosureDigest: digest("d"),
    expiresAt: "2026-07-31T06:00:00.000Z",
    now: () => Date.parse("2026-07-31T05:00:00.000Z")
  };
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

test("seeded protected-effect fuzzing never widens authority", () => {
  const next = seededRandom(EFFECT_FUZZ_SEED);
  const policy = compilePolicy({
    policyId: "fuzz-policy",
    rules: [{
      id: "ask-exact-modify",
      match: EFFECT_BINDING,
      decision: "ask"
    }]
  });
  const admittedDecision = evaluatePolicy(policy, ADMISSION);
  assert.equal(admittedDecision.decision, "ask");

  for (let index = 0; index < EFFECT_MUTATION_CASES; index += 1) {
    const candidate = structuredClone(ADMISSION);
    const changes = 1 + (next() % 4);
    for (let change = 0; change < changes; change += 1) {
      const key = BINDING_KEYS[next() % BINDING_KEYS.length];
      candidate[key] = MUTATED_VALUES[next() % MUTATED_VALUES.length];
    }
    const decision = evaluatePolicy(policy, candidate);
    assert.equal(decision.decision, "deny");
    assert.throws(
      () => compileEffectIntent(effectIntentInput({
        admission: candidate,
        policyDecision: decision,
        arguments: { content: "fuzz-secret-denied" }
      })),
      TypeError
    );
  }

  for (let index = 0; index < POLICY_MUTATION_CASES; index += 1) {
    const match = structuredClone(EFFECT_BINDING);
    const key = BINDING_KEYS[next() % BINDING_KEYS.length];
    if (next() % 2 === 0) {
      delete match[key];
    } else {
      match[key] = MUTATED_VALUES[next() % MUTATED_VALUES.length];
    }
    try {
      const candidate = compilePolicy({
        policyId: "mutated-policy",
        rules: [{ id: "mutated-rule", match, decision: "ask" }]
      });
      assert.equal(evaluatePolicy(candidate, ADMISSION).decision, "deny");
    } catch (error) {
      assert.ok(error instanceof TypeError);
    }
  }

  for (let index = 0; index < ARGUMENT_CASES; index += 1) {
    const input = effectIntentInput({
      policyDecision: admittedDecision,
      arguments: { payload: randomJson(next) }
    });
    const first = compileEffectIntent(input);
    const second = compileEffectIntent(input);
    assert.deepEqual(first, second);
    assert.equal(verifyEffectIntent(first), first);
    assert.equal(JSON.stringify(first).includes("fuzz-secret-"), false);
  }

  process.stdout.write(`${JSON.stringify({
    kind: "effectgate_protected_effect_fuzz_evidence",
    seed: `0x${EFFECT_FUZZ_SEED.toString(16)}`,
    admission_mutations: EFFECT_MUTATION_CASES,
    policy_mutations: POLICY_MUTATION_CASES,
    argument_cases: ARGUMENT_CASES,
    authority_widenings: 0
  })}\n`);
});
