import process from "node:process";
import { fileURLToPath } from "node:url";

import {
  readBoundedJsonLines,
  writeMessage
} from "../../src/proxy/jsonl-rpc.mjs";
import { MCP_VERSION } from "../../src/proxy/mcp-contract.mjs";

export const RESOURCE_BACKEND_IDENTITY = Object.freeze({
  name: "effectgate-resource-fixture",
  version: "1.0.0"
});

export const RESOURCE_BACKEND_TOOL = Object.freeze({
  name: "resource_probe",
  description: "Deterministic read-only resource qualification probe.",
  inputSchema: {
    type: "object",
    additionalProperties: false
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  }
});

function reply(id, result) {
  writeMessage(process.stdout, { jsonrpc: "2.0", id, result });
}

export function runResourceBackend() {
  readBoundedJsonLines(process.stdin, {
    onMessage(message) {
      if (message?.id === undefined) return;
      if (message.method === "ping" &&
          message.params?.effectgate_fixture === "hold") {
        return;
      }
      if (message.method === "ping" &&
          message.params?.effectgate_fixture === "crash") {
        process.exit(70);
      }
      if (message.method === "initialize") {
        reply(message.id, {
          protocolVersion: MCP_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: RESOURCE_BACKEND_IDENTITY
        });
        return;
      }
      if (message.method === "tools/list") {
        reply(message.id, { tools: [RESOURCE_BACKEND_TOOL] });
        return;
      }
      if (message.method === "ping") {
        reply(message.id, {});
        return;
      }
      writeMessage(process.stdout, {
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32601, message: "Method unavailable." }
      });
    },
    onError() {
      process.exit(2);
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  runResourceBackend();
}
