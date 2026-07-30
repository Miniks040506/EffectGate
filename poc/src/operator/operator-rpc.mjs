import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  rmSync
} from "node:fs";
import { createConnection, createServer } from "node:net";
import { join, resolve } from "node:path";
import process from "node:process";

import { MAX_FRAME_BYTES } from "../proxy/jsonl-rpc.mjs";

const TIMEOUT_MS = 5000;

function endpointFor(stateDirectory) {
  const root = resolve(stateDirectory);
  if (process.platform !== "win32") {
    return join(root, ".effectgate-operator.sock");
  }
  const id = createHash("sha256").update(root).digest("hex").slice(0, 32);
  return `\\\\.\\pipe\\effectgate-${id}`;
}

function frame(value) {
  const body = Buffer.from(JSON.stringify(value));
  if (body.length < 2 || body.length > MAX_FRAME_BYTES) {
    throw new Error("operator RPC frame is invalid");
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(body.length);
  return Buffer.concat([header, body]);
}

function readFrame(socket, receive, reject) {
  let buffered = Buffer.alloc(0);
  let expected;
  socket.on("data", (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    if (buffered.length > MAX_FRAME_BYTES + 4) {
      reject(new Error("operator RPC frame is invalid"));
      return;
    }
    if (expected === undefined && buffered.length >= 4) {
      expected = buffered.readUInt32BE();
      if (expected < 2 || expected > MAX_FRAME_BYTES) {
        reject(new Error("operator RPC frame is invalid"));
        return;
      }
    }
    if (expected === undefined || buffered.length < expected + 4) return;
    if (buffered.length !== expected + 4) {
      reject(new Error("operator RPC frame is invalid"));
      return;
    }
    try {
      const text = new TextDecoder("utf-8", { fatal: true }).decode(
        buffered.subarray(4)
      );
      receive(JSON.parse(text));
    } catch {
      reject(new Error("operator RPC frame is invalid"));
    }
  });
}

function safeCode(error) {
  return /^EG_[A-Z0-9_]+$/u.test(error?.code ?? "")
    ? error.code
    : "EG_OPERATOR_REQUEST_FAILED";
}

function endpointActive(endpoint) {
  return new Promise((accept) => {
    const socket = createConnection(endpoint);
    const finish = (active) => {
      socket.destroy();
      accept(active);
    };
    socket.setTimeout(250, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

export async function createOperatorRpcServer({
  stateDirectory,
  dispatch
} = {}) {
  if (typeof stateDirectory !== "string" || typeof dispatch !== "function") {
    throw new TypeError("invalid operator RPC server");
  }
  const endpoint = endpointFor(stateDirectory);
  if (process.platform !== "win32" && existsSync(endpoint)) {
    if (!lstatSync(endpoint).isSocket()) {
      throw new Error("operator RPC endpoint is unsafe");
    }
    if (await endpointActive(endpoint)) {
      throw new Error("operator RPC endpoint is already active");
    }
    rmSync(endpoint, { force: true });
  }
  const server = createServer((socket) => {
    socket.setTimeout(TIMEOUT_MS, () => socket.destroy());
    let handled = false;
    const reject = () => socket.destroy();
    readFrame(socket, async (request) => {
      if (handled) return reject();
      handled = true;
      let response;
      try {
        response = {
          schema_version: "1.0.0",
          ok: true,
          result: await dispatch(request)
        };
      } catch (error) {
        response = {
          schema_version: "1.0.0",
          ok: false,
          error_code: safeCode(error)
        };
      }
      try {
        socket.end(frame(response));
      } catch {
        socket.destroy();
      }
    }, reject);
  });
  server.maxConnections = 8;
  await new Promise((accept, reject) => {
    server.once("error", reject);
    server.listen({
      path: endpoint,
      readableAll: false,
      writableAll: false
    }, () => {
      server.off("error", reject);
      accept();
    });
  });
  if (process.platform !== "win32") {
    try {
      chmodSync(endpoint, 0o600);
    } catch (error) {
      await new Promise((accept) => server.close(accept));
      rmSync(endpoint, { force: true });
      throw error;
    }
  }
  return {
    endpoint,
    async close() {
      await new Promise((accept) => server.close(accept));
      if (process.platform !== "win32") rmSync(endpoint, { force: true });
    }
  };
}

export function operatorRpcRequest(stateDirectory, request) {
  const endpoint = endpointFor(stateDirectory);
  return new Promise((resolveRequest, rejectRequest) => {
    const socket = createConnection(endpoint);
    const fail = (error) => {
      socket.destroy();
      rejectRequest(error);
    };
    socket.setTimeout(TIMEOUT_MS, () =>
      fail(new Error("operator RPC request timed out")));
    socket.once("error", () =>
      fail(new Error("operator RPC channel is unavailable")));
    readFrame(socket, (response) => {
      socket.end();
      const keys = response?.ok
        ? ["schema_version", "ok", "result"]
        : ["schema_version", "ok", "error_code"];
      if (!response || typeof response !== "object" ||
          Array.isArray(response) ||
          Reflect.ownKeys(response).length !== keys.length ||
          keys.some((key) => !Object.hasOwn(response, key)) ||
          response.schema_version !== "1.0.0" ||
          typeof response.ok !== "boolean" ||
          response.ok !== Object.hasOwn(response, "result") ||
          response.ok === Object.hasOwn(response, "error_code")) {
        fail(new Error("operator RPC response is invalid"));
        return;
      }
      if (!response.ok) {
        const error = new Error("operator RPC request was denied");
        error.code = /^EG_[A-Z0-9_]+$/u.test(response.error_code ?? "")
          ? response.error_code
          : "EG_OPERATOR_REQUEST_FAILED";
        fail(error);
        return;
      }
      resolveRequest(response.result);
    }, fail);
    socket.once("connect", () => {
      try {
        socket.write(frame(request));
      } catch (error) {
        fail(error);
      }
    });
  });
}
