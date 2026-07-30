import process from "node:process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";

const MAX_LAYERS = 8;
const MAX_LAYER_BYTES = 64 * 1024;
const MAX_TOTAL_BYTES = 256 * 1024;
const MAX_SECRET_BYTES = 64 * 1024;
const MAX_TOTAL_SECRET_BYTES = 256 * 1024;
const ENVIRONMENT_NAME = /^[A-Z_][A-Z0-9_]{0,127}$/u;

export const BACKEND_BASE_ENVIRONMENT = Object.freeze([
  "PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR",
  "COMSPEC", "TEMP", "TMP"
]);
const RESERVED_ENVIRONMENT = new Set(
  BACKEND_BASE_ENVIRONMENT.map((name) => name.toUpperCase())
);

function plain(value) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function bounded(value, maximum) {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !value.includes("\0") && value === value.normalize("NFC");
}

function readLayer(file, state) {
  if (state.seen.size >= MAX_LAYERS) {
    throw new TypeError("too many configuration layers");
  }
  const path = realpathSync(resolve(file));
  if (state.seen.has(path)) {
    throw new TypeError("configuration layer cycle");
  }
  const size = statSync(path).size;
  state.bytes += size;
  if (size < 2 || size > MAX_LAYER_BYTES ||
      state.bytes > MAX_TOTAL_BYTES) {
    throw new TypeError("invalid configuration layer size");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    readFileSync(path)
  );
  const layer = JSON.parse(text);
  if (!plain(layer) ||
      (layer.extends !== undefined &&
        !bounded(layer.extends, 1024)) ||
      (layer.secret_refs !== undefined &&
        !plain(layer.secret_refs))) {
    throw new TypeError("invalid configuration layer");
  }
  state.seen.add(path);
  const parent = layer.extends === undefined
    ? { value: Object.create(null), files: [] }
    : readLayer(resolve(dirname(path), layer.extends), state);
  const value = Object.assign(Object.create(null), parent.value);
  for (const [key, entry] of Object.entries(layer)) {
    if (key !== "extends" && key !== "secret_refs") value[key] = entry;
  }
  if (parent.value.secret_refs !== undefined ||
      layer.secret_refs !== undefined) {
    value.secret_refs = Object.assign(
      Object.create(null),
      parent.value.secret_refs ?? {},
      layer.secret_refs ?? {}
    );
  }
  return { value, files: [...parent.files, path] };
}

export function loadLayeredConfiguration(file) {
  if (!bounded(file, 1024)) {
    throw new TypeError("invalid layered configuration");
  }
  try {
    const loaded = readLayer(file, {
      bytes: 0,
      seen: new Set()
    });
    return Object.freeze({
      value: loaded.value,
      files: Object.freeze(loaded.files)
    });
  } catch {
    throw new TypeError("invalid layered configuration");
  }
}

export function normalizeEnvironmentSecretRefs(value = {}) {
  if (!plain(value) || Reflect.ownKeys(value).length > 64) {
    throw new TypeError("invalid environment secret references");
  }
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right));
  for (const [target, reference] of entries) {
    const source = typeof reference === "string" &&
      reference.startsWith("env:") ? reference.slice(4) : "";
    if (!ENVIRONMENT_NAME.test(target) ||
        RESERVED_ENVIRONMENT.has(target.toUpperCase()) ||
        !ENVIRONMENT_NAME.test(source)) {
      throw new TypeError("invalid environment secret references");
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

export function normalizeSecretEnvironment(value = {}) {
  if (!plain(value) || Reflect.ownKeys(value).length > 64) {
    throw new TypeError("invalid backend secret environment");
  }
  let bytes = 0;
  const entries = Object.entries(value).sort(([left], [right]) =>
    left.localeCompare(right));
  for (const [name, secret] of entries) {
    bytes += typeof secret === "string"
      ? Buffer.byteLength(secret, "utf8") : MAX_TOTAL_SECRET_BYTES + 1;
    if (!ENVIRONMENT_NAME.test(name) ||
        RESERVED_ENVIRONMENT.has(name.toUpperCase()) ||
        typeof secret !== "string" || secret.length === 0 ||
        secret.includes("\0") ||
        Buffer.byteLength(secret, "utf8") > MAX_SECRET_BYTES ||
        bytes > MAX_TOTAL_SECRET_BYTES) {
      throw new TypeError("invalid backend secret environment");
    }
  }
  return Object.freeze(Object.fromEntries(entries));
}

export function resolveEnvironmentSecretRefs(
  references, environment = process.env
) {
  const normalized = normalizeEnvironmentSecretRefs(references);
  const resolved = {};
  for (const [target, reference] of Object.entries(normalized)) {
    resolved[target] = environment[reference.slice(4)];
  }
  return normalizeSecretEnvironment(resolved);
}
