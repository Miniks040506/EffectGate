export class SkillRpcClient {
  #nextId = 0;
  #rpc;

  constructor(rpc) {
    if (!rpc || typeof rpc.dispatch !== "function") {
      throw new TypeError("invalid Skill RPC harness");
    }
    this.#rpc = rpc;
  }

  request(method, params = {}) {
    const response = this.#rpc.dispatch({
      jsonrpc: "2.0",
      id: ++this.#nextId,
      method,
      params
    });
    if (response.error) {
      const error = new Error(response.error.message);
      error.rpcCode = response.error.code;
      error.effectgateCode = response.error.data?.effectgate_code;
      throw error;
    }
    return response.result;
  }

  async requestAsync(method, params = {}) {
    if (typeof this.#rpc.dispatchAsync !== "function") {
      throw new TypeError("Skill RPC does not support asynchronous requests");
    }
    const response = await this.#rpc.dispatchAsync({
      jsonrpc: "2.0",
      id: ++this.#nextId,
      method,
      params
    });
    if (response.error) {
      const error = new Error(response.error.message);
      error.rpcCode = response.error.code;
      error.effectgateCode = response.error.data?.effectgate_code;
      error.safeReasonCode = response.error.data?.safe_reason_code;
      throw error;
    }
    return response.result;
  }
}
