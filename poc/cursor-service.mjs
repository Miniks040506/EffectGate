import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual
} from "node:crypto";

export const CURSOR_MAX_BYTES = 2048;
export const CURSOR_PATTERN =
  "^cur_[A-Za-z0-9_-]{64,1536}\\.[A-Za-z0-9_-]{43}$";

const CURSOR_VERSION = 1;
const CURSOR_DOMAIN = "effectgate.cursor.v1";
const ARTIFACT_PATTERN = /^art_[a-f0-9]{64}$/u;
const VIEW_PATTERN = /^view_[A-Za-z0-9_-]{24}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const NONCE_PATTERN = /^[A-Za-z0-9_-]{22}$/u;
const TOKEN_PATTERN = new RegExp(CURSOR_PATTERN, "u");

export class InvalidCursorTokenError extends Error {
  constructor() {
    super("invalid cursor token");
    this.name = "InvalidCursorTokenError";
  }
}

function sha256(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

function bindingDigest(name, value) {
  return createHash("sha256")
    .update(`${CURSOR_DOMAIN}\0${name}\0${value}`)
    .digest("base64url");
}

function validBinding(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    Buffer.byteLength(value, "utf8") <= 512
  );
}

function validClaims(claims) {
  return (
    Array.isArray(claims) &&
    claims.length === 12 &&
    claims[0] === CURSOR_VERSION &&
    typeof claims[1] === "string" &&
    ARTIFACT_PATTERN.test(claims[1]) &&
    typeof claims[2] === "string" &&
    VIEW_PATTERN.test(claims[2]) &&
    Number.isSafeInteger(claims[3]) &&
    claims[3] >= 0 &&
    typeof claims[4] === "string" &&
    DIGEST_PATTERN.test(claims[4]) &&
    Number.isSafeInteger(claims[5]) &&
    claims[5] >= 1 &&
    claims.slice(6, 10).every(
      (value) => typeof value === "string" && BINDING_PATTERN.test(value)
    ) &&
    Number.isSafeInteger(claims[10]) &&
    claims[10] >= 1 &&
    typeof claims[11] === "string" &&
    NONCE_PATTERN.test(claims[11])
  );
}

export class CursorService {
  constructor({
    maxCursors,
    ttlMs,
    now,
    principalId,
    clientId,
    sessionId,
    policyGeneration
  }) {
    if (
      !Number.isSafeInteger(maxCursors) ||
      maxCursors < 2 ||
      !Number.isSafeInteger(ttlMs) ||
      ttlMs < 1 ||
      typeof now !== "function" ||
      ![
        principalId,
        clientId,
        sessionId,
        policyGeneration
      ].every(validBinding)
    ) {
      throw new TypeError("cursor service options are invalid");
    }

    this.maxCursors = maxCursors;
    this.ttlMs = ttlMs;
    this.now = now;
    this.key = randomBytes(32);
    this.bindings = [
      bindingDigest("principal", principalId),
      bindingDigest("client", clientId),
      bindingDigest("session", sessionId),
      bindingDigest("policy", policyGeneration)
    ];
    this.states = new Map();
  }

  issue({
    artifactId,
    viewId,
    offset,
    operation,
    budget,
    advancing
  }) {
    if (
      typeof artifactId !== "string" ||
      !ARTIFACT_PATTERN.test(artifactId) ||
      typeof viewId !== "string" ||
      !VIEW_PATTERN.test(viewId) ||
      !Number.isSafeInteger(offset) ||
      offset < 0 ||
      operation === null ||
      typeof operation !== "object" ||
      Array.isArray(operation) ||
      !Number.isSafeInteger(budget) ||
      budget < 1 ||
      typeof advancing !== "boolean"
    ) {
      throw new TypeError("cursor state is invalid");
    }

    const currentTime = this.now();
    this.prune();
    const limit = advancing ? this.maxCursors : this.maxCursors - 1;
    while (this.states.size >= limit) {
      const replay = [...this.states].find(([, state]) => state.view);
      if (!replay) throw new RangeError("retrieval cursor capacity is full");
      this.states.delete(replay[0]);
    }

    let nonce;
    do {
      nonce = randomBytes(16).toString("base64url");
    } while (this.states.has(nonce));
    const expiresAt = currentTime + this.ttlMs;
    const operationDigest = sha256(
      Buffer.from(JSON.stringify(operation), "utf8")
    );
    const claims = [
      CURSOR_VERSION,
      artifactId,
      viewId,
      offset,
      operationDigest,
      budget,
      ...this.bindings,
      expiresAt,
      nonce
    ];
    const payload = Buffer.from(JSON.stringify(claims), "utf8").toString(
      "base64url"
    );
    const mac = createHmac("sha256", this.key)
      .update(payload)
      .digest("base64url");
    const cursor = `cur_${payload}.${mac}`;
    if (Buffer.byteLength(cursor, "utf8") > CURSOR_MAX_BYTES) {
      throw new RangeError("retrieval cursor exceeds its output limit");
    }
    this.states.set(nonce, {
      artifactId,
      viewId,
      offset,
      operation,
      operationDigest,
      budget,
      expiresAt
    });
    return { cursor, expiresAt };
  }

  resolve(cursor) {
    if (
      typeof cursor !== "string" ||
      Buffer.byteLength(cursor, "utf8") > CURSOR_MAX_BYTES
    ) {
      throw new InvalidCursorTokenError();
    }
    if (!TOKEN_PATTERN.test(cursor)) throw new InvalidCursorTokenError();
    const [payload, encodedMac] = cursor.slice(4).split(".");
    let suppliedMac;
    try {
      suppliedMac = Buffer.from(encodedMac, "base64url");
    } catch {
      throw new InvalidCursorTokenError();
    }
    if (suppliedMac.toString("base64url") !== encodedMac) {
      throw new InvalidCursorTokenError();
    }
    const expectedMac = createHmac("sha256", this.key)
      .update(payload)
      .digest();
    if (
      suppliedMac.length !== expectedMac.length ||
      !timingSafeEqual(suppliedMac, expectedMac)
    ) {
      throw new InvalidCursorTokenError();
    }

    let claims;
    try {
      const decoded = Buffer.from(payload, "base64url");
      if (decoded.toString("base64url") !== payload) {
        throw new InvalidCursorTokenError();
      }
      claims = JSON.parse(decoded.toString("utf8"));
    } catch {
      throw new InvalidCursorTokenError();
    }
    if (!validClaims(claims)) throw new InvalidCursorTokenError();
    const [
      ,
      artifactId,
      viewId,
      offset,
      operationDigest,
      budget,
      ...tail
    ] = claims;
    const bindings = tail.slice(0, 4);
    const expiresAt = tail[4];
    const nonce = tail[5];
    if (bindings.some((value, index) => value !== this.bindings[index])) {
      throw new InvalidCursorTokenError();
    }
    if (expiresAt <= this.now()) {
      this.states.delete(nonce);
      throw new InvalidCursorTokenError();
    }

    const state = this.states.get(nonce);
    if (
      !state ||
      state.artifactId !== artifactId ||
      state.viewId !== viewId ||
      state.offset !== offset ||
      state.operationDigest !== operationDigest ||
      state.budget !== budget ||
      state.expiresAt !== expiresAt
    ) {
      throw new InvalidCursorTokenError();
    }
    return state;
  }

  prune() {
    const currentTime = this.now();
    for (const [nonce, state] of this.states) {
      if (state.expiresAt <= currentTime) this.states.delete(nonce);
    }
  }

  isPinned(artifactId) {
    return [...this.states.values()].some(
      (state) => state.artifactId === artifactId && state.view === undefined
    );
  }

  clear() {
    this.states.clear();
    this.key.fill(0);
  }
}
