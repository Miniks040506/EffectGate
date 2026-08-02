import {
  EFFECTGATE_VERSION,
  MAX_TOOL_RESULT_BYTES,
  MCP_VERSION
} from "../proxy/mcp-contract.mjs";
import { deepFreeze } from "./passport-compiler.mjs";
import { SkillRpc } from "./skill-rpc.mjs";

const MAX_ID_BYTES = 128;
const CALL_ARGUMENT_KEYS = [
  "transaction_id", "operation_id", "receipt_id", "capsule_digest",
  "arguments", "resource_scope", "disclosure_digest"
];

function error(id, code, message) {
  const safeId = Number.isSafeInteger(id) ||
    (typeof id === "string" && Buffer.byteLength(id) <= MAX_ID_BYTES)
    ? id
    : null;
  return { jsonrpc: "2.0", id: safeId, error: { code, message } };
}

function exactData(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      return descriptor?.enumerable && Object.hasOwn(descriptor, "value");
    });
}

function validRequest(request) {
  const id = request?.id;
  return request && typeof request === "object" && !Array.isArray(request) &&
    request.jsonrpc === "2.0" && typeof request.method === "string" &&
    (id === undefined || Number.isSafeInteger(id) ||
      (typeof id === "string" && Buffer.byteLength(id) <= MAX_ID_BYTES));
}

function bounded(value) {
  return Buffer.byteLength(JSON.stringify(value)) <= MAX_TOOL_RESULT_BYTES;
}

function toolResult(result) {
  return {
    content: [{ type: "text", text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false
  };
}

function toolError(response) {
  const code = response.error?.data?.effectgate_code;
  const reason = response.error?.data?.safe_reason_code;
  return {
    content: [{
      type: "text",
      text: "EffectGate denied the verified effect command."
    }],
    ...(code
      ? {
          structuredContent: {
            effectgate_code: code,
            ...(reason ? { safe_reason_code: reason } : {})
          }
        }
      : {}),
    isError: true
  };
}

function boundPublication(publication, binding) {
  if (binding === undefined) {
    return { ...publication, call_keys: CALL_ARGUMENT_KEYS, binding: {} };
  }
  if (!exactData(binding, ["transaction_id", "capsule_digest"]) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(
        binding.transaction_id ?? ""
      ) ||
      !/^sha256:[a-f0-9]{64}$/u.test(binding.capsule_digest ?? "")) {
    throw new TypeError("invalid Skill MCP binding");
  }
  const contract = structuredClone(publication.contract);
  for (const key of ["transaction_id", "capsule_digest"]) {
    contract.inputSchema.required =
      contract.inputSchema.required.filter((name) => name !== key);
    delete contract.inputSchema.properties[key];
  }
  return {
    ...publication,
    contract: deepFreeze(contract),
    call_keys: CALL_ARGUMENT_KEYS.filter(
      (key) => !Object.hasOwn(binding, key)
    ),
    binding: deepFreeze({ ...binding })
  };
}

export class SkillMcp {
  #admitted = new Map();
  #lifecycle = "new";
  #rpc;
  #tools;

  constructor(rpc, { bindings = {} } = {}) {
    if (!(rpc instanceof SkillRpc) ||
        !bindings || typeof bindings !== "object" ||
        Array.isArray(bindings)) {
      throw new TypeError("invalid Skill MCP runtime");
    }
    this.#rpc = rpc;
    const publications = SkillRpc.prototype.effectTools.call(rpc);
    const names = new Set(publications.map(({ contract }) => contract.name));
    if (Object.keys(bindings).some((name) => !names.has(name))) {
      throw new TypeError("invalid Skill MCP binding");
    }
    this.#tools = new Map(publications.map((publication) => [
      publication.contract.name,
      boundPublication(publication, bindings[publication.contract.name])
    ]));
  }

  async dispatch(request) {
    const id = request?.id;
    if (!validRequest(request)) {
      return error(id, -32600, "The JSON-RPC request is invalid.");
    }
    if (id === undefined) {
      if (request.method === "notifications/initialized" &&
          this.#lifecycle === "awaiting_initialized") {
        this.#lifecycle = "ready";
      }
      return null;
    }
    if (request.method === "initialize") {
      if (this.#lifecycle !== "new") {
        return error(id, -32600, "This MCP session is already initialized.");
      }
      if (request.params?.protocolVersion !== MCP_VERSION) {
        return error(
          id,
          -32602,
          `This EffectGate build supports MCP ${MCP_VERSION} only.`
        );
      }
      this.#lifecycle = "awaiting_initialized";
      this.#admitted = new Map();
      return {
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: MCP_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: {
            name: "effectgate-skill-runtime",
            version: EFFECTGATE_VERSION
          }
        }
      };
    }
    if (this.#lifecycle !== "ready") {
      return error(id, -32007, "The MCP session is not initialized.");
    }
    if (request.method === "ping") {
      return { jsonrpc: "2.0", id, result: {} };
    }
    if (request.method === "tools/list") {
      if (!exactData(request.params ?? {}, [])) {
        return error(id, -32602, "The tools cursor is invalid.");
      }
      const result = {
        tools: [...this.#tools.values()].map(({ contract }) => contract)
      };
      if (!bounded(result)) {
        return error(
          id,
          -32005,
          `The response exceeds the ${MAX_TOOL_RESULT_BYTES}-byte result limit.`
        );
      }
      this.#admitted = new Map(this.#tools);
      return { jsonrpc: "2.0", id, result };
    }
    if (request.method !== "tools/call") {
      return error(id, -32601, "The requested method is unavailable.");
    }
    if (!exactData(request.params, ["name", "arguments"]) ||
        typeof request.params.name !== "string") {
      return error(id, -32602, "The effect tool arguments are invalid.");
    }
    const publication = this.#admitted.get(request.params.name);
    if (!publication) {
      return error(id, -32602, "The effect tool name is invalid.");
    }
    if (!exactData(request.params.arguments, publication.call_keys)) {
      return error(id, -32602, "The effect tool arguments are invalid.");
    }
    const response = await SkillRpc.prototype.dispatchAsync.call(
      this.#rpc,
      {
        jsonrpc: "2.0",
        id,
        method: "skills/effect/execute",
        params: {
          ...request.params.arguments,
          ...publication.binding,
          capability_id: publication.capability_id,
          capability_revision: publication.capability_revision,
          effect_class: publication.effect_class
        }
      }
    );
    const result = response.error ? toolError(response) : toolResult(
      response.result
    );
    return bounded(result)
      ? { jsonrpc: "2.0", id, result }
      : error(
        id,
        -32005,
        `The response exceeds the ${MAX_TOOL_RESULT_BYTES}-byte result limit.`
      );
  }
}
