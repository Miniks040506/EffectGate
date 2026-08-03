import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import process from "node:process";

const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/;
const IO_CHUNK_BYTES = 64 * 1024;
const OWNED_ROOT_PREFIX = "effectgate-cas-";
const ownedRoots = new Set();
let cleanupRegistered = false;

export class CorruptArtifactError extends Error {
  constructor() {
    super("stored artifact failed integrity validation");
    this.name = "CorruptArtifactError";
  }
}

function validateDigest(digest) {
  if (typeof digest !== "string" || !DIGEST_PATTERN.test(digest)) {
    throw new TypeError("digest must be a SHA-256 digest");
  }
}

function privacyPartitionDigest(value) {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    Buffer.byteLength(value, "utf8") > 512
  ) {
    throw new TypeError("privacyPartition must be a bounded string");
  }
  return createHash("sha256")
    .update(`effectgate.cas.partition.v1\0${value}`)
    .digest("hex");
}

function writeAll(file, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    offset += fs.writeSync(file, chunk, offset, chunk.length - offset);
  }
}

function syncDirectory(directory) {
  if (process.platform === "win32") return;
  const file = fs.openSync(directory, "r");
  try {
    fs.fsyncSync(file);
  } finally {
    fs.closeSync(file);
  }
}

function removeOwnedRoot(root) {
  const temporaryRoot = `${resolve(tmpdir())}${sep}`.toLowerCase();
  const candidate = resolve(root);
  if (
    !candidate.toLowerCase().startsWith(temporaryRoot) ||
    !basename(candidate).startsWith(OWNED_ROOT_PREFIX)
  ) {
    throw new Error("refusing to remove an unowned CAS directory");
  }
  fs.rmSync(candidate, { recursive: true, force: true });
}

function registerOwnedRoot(root) {
  ownedRoots.add(root);
  if (cleanupRegistered) return;
  cleanupRegistered = true;
  process.once("exit", () => {
    for (const ownedRoot of ownedRoots) removeOwnedRoot(ownedRoot);
  });
}

export class FilesystemCas {
  constructor({
    directory,
    maxObjectBytes = 1024 * 1024,
    privacyPartition = "default"
  } = {}) {
    if (!Number.isSafeInteger(maxObjectBytes) || maxObjectBytes < 1) {
      throw new TypeError("maxObjectBytes must be a positive integer");
    }
    if (directory !== undefined &&
        (typeof directory !== "string" || directory.length === 0)) {
      throw new TypeError("directory must be a non-empty string");
    }

    this.owned = directory === undefined;
    this.root = this.owned
      ? fs.mkdtempSync(join(tmpdir(), OWNED_ROOT_PREFIX))
      : resolve(directory);
    this.partitionRoot = join(
      this.root,
      "partitions",
      privacyPartitionDigest(privacyPartition)
    );
    this.maxObjectBytes = maxObjectBytes;
    this.tmpDirectory = join(this.partitionRoot, "tmp");
    this.objectsDirectory = join(this.partitionRoot, "objects", "sha256");
    this.quarantineDirectory = join(this.partitionRoot, "quarantine");
    this.closed = false;

    fs.mkdirSync(this.tmpDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.objectsDirectory, { recursive: true, mode: 0o700 });
    fs.mkdirSync(this.quarantineDirectory, { recursive: true, mode: 0o700 });
    this.recoveredParts = this.recoverInterruptedWrites();
    if (this.owned) registerOwnedRoot(this.root);
  }

  ensureOpen() {
    if (this.closed) throw new Error("CAS is closed");
  }

  objectPath(digest) {
    validateDigest(digest);
    const hex = digest.slice("sha256:".length);
    return join(this.objectsDirectory, hex.slice(0, 2), hex.slice(2, 4), hex);
  }

  recoverInterruptedWrites() {
    let recovered = 0;
    const entries = fs.readdirSync(this.tmpDirectory, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() &&
          /^upload_[A-Za-z0-9_-]{20,}\.part$/.test(entry.name)) {
        fs.unlinkSync(join(this.tmpDirectory, entry.name));
        recovered += 1;
      }
    }
    if (recovered > 0) syncDirectory(this.tmpDirectory);
    return recovered;
  }

  put(chunks, { expectedBytes, expectedDigest } = {}) {
    this.ensureOpen();
    if (chunks == null || typeof chunks[Symbol.iterator] !== "function") {
      throw new TypeError("chunks must be iterable");
    }
    if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0 ||
        expectedBytes > this.maxObjectBytes) {
      throw new RangeError("expectedBytes exceeds the CAS object limit");
    }
    if (expectedDigest !== undefined) validateDigest(expectedDigest);

    const uploadId = randomBytes(18).toString("base64url");
    const temporaryPath = join(this.tmpDirectory, `upload_${uploadId}.part`);
    const hash = createHash("sha256");
    let acceptedBytes = 0;
    let file = fs.openSync(temporaryPath, "wx", 0o600);

    try {
      // ponytail: synchronous 64 KiB writes keep the implementation simple;
      // move this writer off-loop only if corpus latency misses its budget.
      for (const value of chunks) {
        if (!(Buffer.isBuffer(value) || value instanceof Uint8Array)) {
          throw new TypeError("CAS chunks must be byte arrays");
        }
        const chunk = Buffer.isBuffer(value)
          ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength);
        if (acceptedBytes + chunk.length > this.maxObjectBytes) {
          throw new RangeError("artifact exceeds the CAS object limit");
        }
        if (chunk.length === 0) continue;
        hash.update(chunk);
        writeAll(file, chunk);
        acceptedBytes += chunk.length;
      }
      if (acceptedBytes !== expectedBytes) {
        throw new RangeError("artifact length does not match accepted bytes");
      }

      const digest = `sha256:${hash.digest("hex")}`;
      if (expectedDigest !== undefined && digest !== expectedDigest) {
        throw new CorruptArtifactError();
      }
      fs.fsyncSync(file);
      fs.closeSync(file);
      file = undefined;

      const finalPath = this.objectPath(digest);
      fs.mkdirSync(dirname(finalPath), { recursive: true, mode: 0o700 });
      if (fs.existsSync(finalPath)) {
        try {
          this.verify(digest, acceptedBytes);
          fs.unlinkSync(temporaryPath);
          return { digest, bytes: acceptedBytes, deduplicated: true };
        } catch (error) {
          if (!(error instanceof CorruptArtifactError)) throw error;
        }
      }

      try {
        // ponytail: the preview is a single writer; add per-digest locking
        // before multiple processes share a durable CAS root.
        fs.renameSync(temporaryPath, finalPath);
      } catch (error) {
        if (!fs.existsSync(finalPath)) throw error;
        this.verify(digest, acceptedBytes);
        fs.unlinkSync(temporaryPath);
        return { digest, bytes: acceptedBytes, deduplicated: true };
      }
      syncDirectory(dirname(finalPath));
      return { digest, bytes: acceptedBytes, deduplicated: false };
    } catch (error) {
      if (file !== undefined) fs.closeSync(file);
      if (fs.existsSync(temporaryPath)) fs.unlinkSync(temporaryPath);
      throw error;
    }
  }

  verify(digest, expectedBytes) {
    this.readRange(digest, 0, 0, expectedBytes);
  }

  readRange(digest, start, end, expectedBytes) {
    this.ensureOpen();
    validateDigest(digest);
    // ponytail: rehash every configured object for integrity; cache verified
    // handles only after corpus profiling proves this is the bottleneck.
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) ||
        start < 0 || end < start) {
      throw new RangeError("invalid CAS byte range");
    }
    if (expectedBytes !== undefined &&
        (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0)) {
      throw new TypeError("expectedBytes must be a non-negative integer");
    }

    const objectPath = this.objectPath(digest);
    let file;
    try {
      file = fs.openSync(objectPath, "r");
    } catch (error) {
      if (error?.code === "ENOENT") throw new CorruptArtifactError();
      throw error;
    }

    let corrupt = false;
    let output;
    try {
      const size = fs.fstatSync(file).size;
      if (expectedBytes !== undefined && size !== expectedBytes) {
        corrupt = true;
      } else if (end > size) {
        throw new RangeError("CAS byte range exceeds the artifact");
      } else {
        output = Buffer.alloc(end - start);
        const hash = createHash("sha256");
        const bufferSize = Math.min(IO_CHUNK_BYTES, Math.max(size, 1));
        const buffer = Buffer.allocUnsafe(bufferSize);
        let position = 0;

        while (position < size) {
          const length = Math.min(buffer.length, size - position);
          const read = fs.readSync(file, buffer, 0, length, position);
          if (read === 0) {
            corrupt = true;
            break;
          }
          const chunk = buffer.subarray(0, read);
          hash.update(chunk);
          const overlapStart = Math.max(position, start);
          const overlapEnd = Math.min(position + read, end);
          if (overlapEnd > overlapStart) {
            chunk.copy(output, overlapStart - start,
              overlapStart - position, overlapEnd - position);
          }
          position += read;
        }
        if (!corrupt) {
          corrupt = `sha256:${hash.digest("hex")}` !== digest;
        }
      }
    } finally {
      fs.closeSync(file);
    }

    if (corrupt) {
      this.quarantine(digest);
      throw new CorruptArtifactError();
    }
    return output;
  }

  quarantine(digest) {
    const source = this.objectPath(digest);
    if (!fs.existsSync(source)) return;
    const hex = digest.slice("sha256:".length);
    const target = join(
      this.quarantineDirectory,
      `${hex}.${randomBytes(12).toString("base64url")}.corrupt`
    );
    fs.renameSync(source, target);
    syncDirectory(dirname(source));
    syncDirectory(this.quarantineDirectory);
  }

  remove(digest) {
    this.ensureOpen();
    const objectPath = this.objectPath(digest);
    if (!fs.existsSync(objectPath)) return false;
    fs.unlinkSync(objectPath);
    syncDirectory(dirname(objectPath));
    return true;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    if (!this.owned) return;
    ownedRoots.delete(this.root);
    removeOwnedRoot(this.root);
  }
}
