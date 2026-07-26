import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import process from "node:process";

const DEFAULT_PROGRAM = fileURLToPath(
  new URL("../proxy/effectgate.mjs", import.meta.url)
);

export class RpcProcess {
  constructor(args, { program = DEFAULT_PROGRAM, timeoutMs = 5_000 } = {}) {
    if (
      !Array.isArray(args) ||
      args.some((value) => typeof value !== "string") ||
      typeof program !== "string" ||
      program.length < 1 ||
      !Number.isSafeInteger(timeoutMs) ||
      timeoutMs < 1
    ) {
      throw new TypeError("invalid RPC process configuration");
    }
    this.child = spawn(process.execPath, [program, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true
    });
    this.buffer = "";
    this.messages = [];
    this.waiters = [];
    this.stderr = "";
    this.nextId = 0;
    this.timeoutMs = timeoutMs;

    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk) => {
      this.buffer += chunk;
      let newline;
      while ((newline = this.buffer.indexOf("\n")) !== -1) {
        const line = this.buffer.slice(0, newline);
        this.buffer = this.buffer.slice(newline + 1);
        if (line.length === 0) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          this.rejectWaiters(new Error("RPC process returned invalid JSON"));
          this.child.kill();
          return;
        }
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(message);
        else this.messages.push(message);
      }
    });
    this.child.stderr.setEncoding("utf8");
    this.child.stderr.on("data", (chunk) => {
      this.stderr += chunk;
    });
    this.child.on("exit", () => {
      this.rejectWaiters(new Error("RPC process exited before responding"));
    });
    this.child.on("error", (error) => this.rejectWaiters(error));
  }

  rejectWaiters(error) {
    for (const waiter of this.waiters.splice(0)) waiter.reject(error);
  }

  send(message) {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  request(method, params = {}) {
    const id = ++this.nextId;
    this.send({ jsonrpc: "2.0", id, method, params });
    return this.next();
  }

  next() {
    if (this.messages.length > 0) return Promise.resolve(this.messages.shift());
    return new Promise((resolve, reject) => {
      let timeout;
      const waiter = {
        resolve(message) {
          clearTimeout(timeout);
          resolve(message);
        },
        reject(error) {
          clearTimeout(timeout);
          reject(error);
        }
      };
      timeout = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index !== -1) this.waiters.splice(index, 1);
        reject(new Error(`Timed out waiting for response. stderr=${this.stderr}`));
      }, this.timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async stop() {
    if (this.child.exitCode !== null) return;
    const exited = once(this.child, "exit");
    this.child.stdin.end();
    setTimeout(() => this.child.kill(), 500).unref();
    await exited;
  }
}
