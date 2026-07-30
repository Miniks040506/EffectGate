import { createHash } from "node:crypto";
import {
  closeSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep
} from "node:path";
import { DatabaseSync, backup as sqliteBackup } from "node:sqlite";

import { EFFECTGATE_VERSION } from "../proxy/mcp-contract.mjs";
import { canonicalJson } from "../skill/passport-compiler.mjs";
import { databaseIntegrity } from "./operator-state.mjs";

const DATABASE_NAMES = Object.freeze([
  "effect-operations.db",
  "skill-events.db",
  "stdio-effect-backend.db"
]);

export function pathContains(parent, child) {
  const value = relative(parent, child);
  return value === "" ||
    (!isAbsolute(value) && value !== ".." &&
      !value.startsWith(`..${sep}`));
}

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

async function fileDigest(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return `sha256:${hash.digest("hex")}`;
}

function writeExclusive(file, value) {
  const descriptor = openSync(file, "wx", 0o600);
  try {
    writeFileSync(descriptor, value);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function syncFile(file) {
  const descriptor = openSync(file, "r+");
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

async function record(file, path, kind) {
  return {
    kind,
    path,
    bytes: statSync(file).size,
    digest: await fileDigest(file)
  };
}

function sourceDatabases(stateDirectory) {
  const unknown = readdirSync(stateDirectory)
    .filter((name) => name.endsWith(".db") &&
      !DATABASE_NAMES.includes(name));
  if (unknown.length > 0) {
    throw new Error("state directory contains an unknown database");
  }
  return DATABASE_NAMES.filter((name) => {
    const file = join(stateDirectory, name);
    if (!existsSync(file)) return false;
    const metadata = lstatSync(file);
    if (!metadata.isFile() || metadata.isSymbolicLink()) {
      throw new Error("state database is unsafe");
    }
    if (databaseIntegrity(file) !== "pass") {
      throw new Error("state database integrity check failed");
    }
    return true;
  });
}

export async function createStateBackup({
  configFile,
  config,
  outputDirectory
} = {}) {
  if (typeof configFile !== "string" ||
      typeof outputDirectory !== "string" ||
      !config || typeof config !== "object") {
    throw new TypeError("invalid backup request");
  }
  const requestedOutput = resolve(outputDirectory);
  const outputParent = realpathSync(dirname(requestedOutput));
  const output = join(outputParent, basename(requestedOutput));
  const stateDirectory = realpathSync(config.state_directory);
  const skillRoot = realpathSync(config.skill_root);
  if (dirname(output) === output || existsSync(output) ||
      pathContains(stateDirectory, output) ||
      pathContains(skillRoot, output) ||
      pathContains(output, stateDirectory)) {
    throw new Error("unsafe or existing backup destination");
  }
  const databases = sourceDatabases(stateDirectory);
  mkdirSync(output, { mode: 0o700 });
  const databaseDirectory = join(output, "databases");
  mkdirSync(databaseDirectory, { mode: 0o700 });

  const configurationBytes = `${canonicalJson(config)}\n`;
  const configurationFile = join(output, "configuration.json");
  writeExclusive(configurationFile, configurationBytes);
  const files = [
    await record(configurationFile, "configuration.json", "configuration")
  ];

  const casManifest = {
    schema_version: "1.0.0",
    kind: "effectgate_cas_manifest",
    state: "not_configured",
    objects: []
  };
  const casFile = join(output, "cas-manifest.json");
  writeExclusive(casFile, `${canonicalJson(casManifest)}\n`);
  files.push(await record(casFile, "cas-manifest.json", "cas_manifest"));

  let guard;
  let locked = false;
  try {
    guard = new DatabaseSync(":memory:");
    for (const [index, name] of databases.entries()) {
      guard.prepare(`ATTACH DATABASE ? AS state_${index}`)
        .run(join(stateDirectory, name));
    }
    guard.exec("BEGIN IMMEDIATE");
    locked = true;
    for (const name of databases) {
      const sourceFile = join(stateDirectory, name);
      if (databaseIntegrity(sourceFile) !== "pass") {
        throw new Error("state database changed during backup preflight");
      }
      const partFile = join(databaseDirectory, `${name}.part`);
      const backupFile = join(databaseDirectory, name);
      const source = new DatabaseSync(sourceFile, { readOnly: true });
      try {
        await sqliteBackup(source, partFile);
      } finally {
        source.close();
      }
      if (databaseIntegrity(partFile) !== "pass") {
        throw new Error("backup database integrity check failed");
      }
      syncFile(partFile);
      renameSync(partFile, backupFile);
      files.push(await record(
        backupFile,
        `databases/${name}`,
        "sqlite"
      ));
    }
    guard.exec("ROLLBACK");
    locked = false;
  } finally {
    if (locked) {
      try {
        guard.exec("ROLLBACK");
      } catch {}
    }
    guard?.close();
  }

  const markerFile = join(stateDirectory, ".effectgate-state.json");
  const manifest = {
    schema_version: "1.0.0",
    kind: "effectgate_state_backup",
    effectgate_version: EFFECTGATE_VERSION,
    created_at: new Date().toISOString(),
    transaction_id: config.transaction_id,
    source: {
      config_file: resolve(configFile),
      configuration_digest: digest(configurationBytes),
      state_directory: resolve(config.state_directory),
      state_marker_digest: await fileDigest(markerFile)
    },
    consistency: {
      database_cut: "sqlite_attached_begin_immediate",
      database_copy: "sqlite_online_backup",
      cas_state: "not_configured"
    },
    files
  };
  const manifestBytes = `${canonicalJson(manifest)}\n`;
  const manifestDigest = digest(manifestBytes);
  const manifestPart = join(output, "manifest.json.part");
  const checksumPart = join(output, "manifest.sha256.part");
  writeExclusive(manifestPart, manifestBytes);
  writeExclusive(
    checksumPart,
    `${manifestDigest.slice("sha256:".length)}  manifest.json\n`
  );
  renameSync(manifestPart, join(output, "manifest.json"));
  renameSync(checksumPart, join(output, "manifest.sha256"));
  return {
    schema_version: "1.0.0",
    command: "backup",
    status: "created",
    output_directory: output,
    manifest_file: join(output, "manifest.json"),
    manifest_digest: manifestDigest,
    database_count: databases.length,
    cas_object_count: 0
  };
}
