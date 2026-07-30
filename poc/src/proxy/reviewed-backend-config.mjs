import { createHash } from "node:crypto";
import process from "node:process";
import {
  closeSync,
  openSync,
  readSync,
  realpathSync,
  statSync
} from "node:fs";
import { resolve } from "node:path";

import {
  loadLayeredConfiguration,
  normalizeEnvironmentSecretRefs
} from "../config/layered-config.mjs";
import {
  canonicalJson,
  deepFreeze
} from "../skill/passport-compiler.mjs";
import {
  MAX_TOOL_RESULT_BYTES,
  isSafeReadTool,
  isValidToolContract
} from "./mcp-contract.mjs";

export const REVIEWED_STDIO_DRIVER =
  "effectgate.reviewed.stdio-read.v1";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const SOURCE = /^[A-Za-z0-9_.-]{1,64}$/u;
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_BYTES = 256 * 1024 * 1024;
const CONFIG_KEYS = [
  "schema_version", "driver", "source", "executable_path",
  "executable_digest", "argv", "working_directory", "source_files",
  "server_identity", "catalog"
];

function exactData(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function bounded(value, maximum) {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !value.includes("\0") && value === value.normalize("NFC");
}

function canonicalFile(file) {
  const path = realpathSync(resolve(file));
  const stat = statSync(path);
  if (!stat.isFile() ||
      (process.platform !== "win32" && (stat.mode & 0o022) !== 0)) {
    throw new TypeError("unsafe reviewed backend file");
  }
  return path;
}

export function reviewedFileDigest(file) {
  const path = canonicalFile(file);
  const descriptor = openSync(path, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(64 * 1024);
  try {
    let bytes;
    while ((bytes = readSync(
      descriptor, buffer, 0, buffer.length, null
    )) > 0) {
      hash.update(buffer.subarray(0, bytes));
    }
  } finally {
    closeSync(descriptor);
  }
  return `sha256:${hash.digest("hex")}`;
}

function normalizeSourceFiles(value) {
  if (!Array.isArray(value) || value.length > 128) {
    throw new TypeError("invalid reviewed source manifest");
  }
  let totalBytes = 0;
  const files = value.map((entry) => {
    if (!exactData(entry, ["path", "digest"]) ||
        !bounded(entry.path, 1024) ||
        !DIGEST.test(entry.digest ?? "")) {
      throw new TypeError("invalid reviewed source manifest");
    }
    const path = canonicalFile(entry.path);
    const bytes = statSync(path).size;
    totalBytes += bytes;
    if (bytes > MAX_SOURCE_FILE_BYTES || totalBytes > MAX_SOURCE_BYTES) {
      throw new TypeError("reviewed source manifest is too large");
    }
    if (reviewedFileDigest(path) !== entry.digest) {
      throw new TypeError("reviewed source digest mismatch");
    }
    return { path, digest: entry.digest };
  }).sort((left, right) => left.path.localeCompare(right.path));
  if (new Set(files.map((entry) => entry.path)).size !== files.length) {
    throw new TypeError("duplicate reviewed source file");
  }
  return files;
}

function normalizeCatalog(value) {
  if (!exactData(value, ["tools"]) ||
      !Array.isArray(value.tools) ||
      value.tools.length > 256 ||
      value.tools.some((tool) => !isValidToolContract(tool)) ||
      new Set(value.tools.map((tool) => tool.name)).size !==
        value.tools.length ||
      !value.tools.some(isSafeReadTool) ||
      Buffer.byteLength(canonicalJson(value), "utf8") >
        MAX_TOOL_RESULT_BYTES) {
    throw new TypeError("invalid reviewed backend catalog");
  }
  // ponytail: one immutable page covers V1; add sealed generations only when
  // a qualified backend proves pagination or list_changed is required.
  return value;
}

export function verifyReviewedBackendFiles(
  config, includeExecutable = true
) {
  if ((includeExecutable &&
        reviewedFileDigest(config.executable_path) !==
          config.executable_digest) ||
      config.source_files.some((entry) =>
        reviewedFileDigest(entry.path) !== entry.digest)) {
    throw new TypeError("reviewed backend source drift");
  }
}

export function normalizeReviewedBackendConfig(value) {
  let secretRefs;
  try {
    secretRefs = value?.secret_refs === undefined
      ? undefined
      : normalizeEnvironmentSecretRefs(value.secret_refs);
  } catch {
    throw new TypeError("invalid reviewed backend configuration");
  }
  const keys = [
    ...CONFIG_KEYS,
    ...(secretRefs === undefined ? [] : ["secret_refs"])
  ];
  if (!exactData(value, keys) ||
      value.schema_version !== "1.0.0" ||
      value.driver !== REVIEWED_STDIO_DRIVER ||
      !SOURCE.test(value.source ?? "") ||
      !bounded(value.executable_path, 1024) ||
      !DIGEST.test(value.executable_digest ?? "") ||
      !Array.isArray(value.argv) ||
      value.argv.length > 128 ||
      value.argv.some((entry) => !bounded(entry, 4096)) ||
      value.argv.reduce(
        (total, entry) => total + Buffer.byteLength(entry, "utf8"),
        0
      ) > 32 * 1024 ||
      !bounded(value.working_directory, 1024) ||
      !exactData(value.server_identity, ["name", "version"]) ||
      !bounded(value.server_identity.name, 128) ||
      !bounded(value.server_identity.version, 128)) {
    throw new TypeError("invalid reviewed backend configuration");
  }
  try {
    const executablePath = canonicalFile(value.executable_path);
    const workingDirectory = realpathSync(resolve(value.working_directory));
    const directoryStat = statSync(workingDirectory);
    if (!directoryStat.isDirectory() ||
        (process.platform !== "win32" &&
          (directoryStat.mode & 0o022) !== 0)) {
      throw new TypeError("unsafe reviewed working directory");
    }
    const config = deepFreeze({
      ...value,
      executable_path: executablePath,
      working_directory: workingDirectory,
      source_files: normalizeSourceFiles(value.source_files),
      server_identity: { ...value.server_identity },
      catalog: normalizeCatalog(value.catalog),
      ...(secretRefs === undefined ? {} : { secret_refs: secretRefs })
    });
    verifyReviewedBackendFiles(config);
    return config;
  } catch {
    throw new TypeError("invalid reviewed backend configuration");
  }
}

export function loadReviewedBackendConfig(file) {
  try {
    const loaded = loadLayeredConfiguration(file);
    return deepFreeze({
      config: normalizeReviewedBackendConfig(loaded.value),
      layers: loaded.files
    });
  } catch {
    throw new TypeError("invalid reviewed backend configuration");
  }
}
