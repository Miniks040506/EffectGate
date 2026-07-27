import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MAX_SKILL_FILE_BYTES = 1024 * 1024;
export const MAX_SKILL_SOURCE_BYTES = 8 * MAX_SKILL_FILE_BYTES;

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const MAX_SKILL_FILES = 512;

export class SkillSourceError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "SkillSourceError";
    this.code = code;
  }
}

function fail(code, message) {
  throw new SkillSourceError(code, message);
}

function canonicalPath(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 1024 ||
    value.includes("\\") ||
    value.includes("\0") ||
    /^[A-Za-z]:/u.test(value) ||
    isAbsolute(value) ||
    value !== value.normalize("NFC")
  ) {
    fail("EG_SKILL_SOURCE_INVALID", "skill path must be bounded relative NFC");
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" ||
      segment === "." || segment === "..")) {
    fail("EG_SKILL_SOURCE_INVALID", "skill path traversal is forbidden");
  }
  return value;
}

function inside(root, candidate) {
  const pathFromRoot = relative(root, candidate);
  return pathFromRoot !== "" &&
    pathFromRoot !== ".." &&
    !pathFromRoot.startsWith(`..${sep}`) &&
    !isAbsolute(pathFromRoot);
}

function openInstruction(root, logicalPath) {
  const candidate = resolve(root, ...logicalPath.split("/"));
  let realFile;
  try {
    realFile = fs.realpathSync(candidate);
  } catch (error) {
    if (error?.code === "ENOENT") {
      fail("EG_SKILL_DEPENDENCY_MISSING", `missing skill file: ${logicalPath}`);
    }
    fail("EG_SKILL_SOURCE_INVALID", `cannot resolve skill file: ${logicalPath}`);
  }
  if (!inside(root, realFile)) {
    fail("EG_SKILL_SOURCE_INVALID", "skill file escapes admitted root");
  }

  let handle;
  try {
    handle = fs.openSync(realFile, "r");
  } catch {
    fail("EG_SKILL_SOURCE_INVALID", `cannot open skill file: ${logicalPath}`);
  }
  try {
    const before = fs.fstatSync(handle);
    if (!before.isFile()) {
      fail("EG_SKILL_SOURCE_INVALID", "skill source entry is not a file");
    }
    if (before.size > MAX_SKILL_FILE_BYTES) {
      fail("EG_SKILL_SOURCE_INVALID", "skill file exceeds byte limit");
    }

    // ponytail: bounded synchronous reads suit local compile-time import;
    // move off-loop only if imports enter the daemon request hot path.
    const bytes = fs.readFileSync(handle);
    const after = fs.fstatSync(handle);
    if (before.size !== after.size ||
        before.mtimeMs !== after.mtimeMs ||
        before.ctimeMs !== after.ctimeMs) {
      fail("EG_SKILL_DIGEST_DRIFT", "skill file changed during import");
    }

    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      fail("EG_SKILL_SOURCE_INVALID", "skill instructions must be valid UTF-8");
    }
    return Object.freeze({
      path: logicalPath,
      text,
      bytes: bytes.length,
      digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`
    });
  } finally {
    fs.closeSync(handle);
  }
}

export function importSkillSource({ root, paths, expectedDigest } = {}) {
  if (typeof root !== "string" || root.length === 0) {
    fail("EG_SKILL_SOURCE_INVALID", "skill root must be a non-empty path");
  }
  if (!Array.isArray(paths) || paths.length < 1 ||
      paths.length > MAX_SKILL_FILES) {
    fail("EG_SKILL_SOURCE_INVALID", "skill paths must be a bounded array");
  }
  if (expectedDigest !== undefined &&
      (typeof expectedDigest !== "string" ||
       !DIGEST_PATTERN.test(expectedDigest))) {
    fail("EG_SKILL_SOURCE_INVALID", "expected digest must be SHA-256");
  }

  let realRoot;
  try {
    realRoot = fs.realpathSync(root);
  } catch {
    fail("EG_SKILL_SOURCE_INVALID", "skill root cannot be resolved");
  }
  if (!fs.statSync(realRoot).isDirectory()) {
    fail("EG_SKILL_SOURCE_INVALID", "skill root must be a directory");
  }
  const canonicalPaths = paths.map(canonicalPath).sort();
  if (new Set(canonicalPaths).size !== canonicalPaths.length ||
      !canonicalPaths.includes("SKILL.md")) {
    fail("EG_SKILL_SOURCE_INVALID", "skill paths must uniquely include SKILL.md");
  }

  const files = canonicalPaths.map((path) => openInstruction(realRoot, path));
  if (files.reduce((sum, file) => sum + file.bytes, 0) >
      MAX_SKILL_SOURCE_BYTES) {
    fail("EG_SKILL_SOURCE_INVALID", "skill source exceeds byte limit");
  }

  const hash = createHash("sha256").update("effectgate.skill-source.v1\0");
  for (const file of files) {
    hash.update(`${Buffer.byteLength(file.path)}:${file.path}\0`);
    hash.update(`${file.bytes}:${file.digest}\0`);
  }
  const sourceDigest = `sha256:${hash.digest("hex")}`;
  if (expectedDigest !== undefined && expectedDigest !== sourceDigest) {
    fail("EG_SKILL_DIGEST_DRIFT", "skill source digest does not match");
  }
  return Object.freeze({
    root: realRoot,
    files: Object.freeze(files),
    source_digest: sourceDigest
  });
}
