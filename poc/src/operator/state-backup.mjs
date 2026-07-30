import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  chmodSync,
  closeSync,
  copyFileSync,
  createReadStream,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
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
import { ApprovalLeaseStore } from "../policy/approval-lease-store.mjs";
import { EffectOperationJournal } from "../policy/operation-journal.mjs";
import { canonicalJson } from "../skill/passport-compiler.mjs";
import {
  SKILL_SOURCE_PATHS,
  normalizeSkillMcpConfig
} from "../skill/skill-runtime-config.mjs";
import { importSkillSource } from "../skill/source-import.mjs";
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

function exact(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Reflect.ownKeys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key));
}

function readBounded(file, maximum) {
  const metadata = lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink() ||
      metadata.size > maximum) {
    throw new Error("unsafe backup metadata");
  }
  return readFileSync(file, "utf8");
}

function freshPath(value) {
  if (typeof value !== "string" || value.length === 0 ||
      Buffer.byteLength(value, "utf8") > 1024 ||
      value.includes("\0") || value !== value.normalize("NFC")) {
    throw new TypeError("invalid restore destination");
  }
  const requested = resolve(value);
  const parent = realpathSync(dirname(requested));
  const output = join(parent, basename(requested));
  if (dirname(output) === output || existsSync(output)) {
    throw new Error("unsafe or existing restore destination");
  }
  return output;
}

async function inspectStateBackup(directory) {
  const requested = resolve(directory);
  const requestedMetadata = lstatSync(requested);
  if (!requestedMetadata.isDirectory() ||
      requestedMetadata.isSymbolicLink()) {
    throw new Error("unsafe backup directory");
  }
  const backupDirectory = realpathSync(requested);
  const topLevel = readdirSync(backupDirectory).sort();
  const expectedTopLevel = [
    "cas-manifest.json",
    "configuration.json",
    "databases",
    "manifest.json",
    "manifest.sha256"
  ];
  if (JSON.stringify(topLevel) !== JSON.stringify(expectedTopLevel)) {
    throw new Error("backup artifact set is invalid");
  }
  const databaseDirectory = join(backupDirectory, "databases");
  const databaseMetadata = lstatSync(databaseDirectory);
  if (!databaseMetadata.isDirectory() ||
      databaseMetadata.isSymbolicLink()) {
    throw new Error("backup database directory is unsafe");
  }
  const databaseNames = readdirSync(databaseDirectory).sort();
  if (databaseNames.some((name) => !DATABASE_NAMES.includes(name))) {
    throw new Error("backup contains an unknown database");
  }

  const manifestText = readBounded(
    join(backupDirectory, "manifest.json"),
    64 * 1024
  );
  const manifestDigest = digest(manifestText);
  if (readBounded(join(backupDirectory, "manifest.sha256"), 128) !==
      `${manifestDigest.slice("sha256:".length)}  manifest.json\n`) {
    throw new Error("backup manifest checksum mismatch");
  }
  let manifest;
  try {
    manifest = JSON.parse(manifestText);
  } catch {
    throw new Error("backup manifest is invalid");
  }
  if (!exact(manifest, [
    "schema_version", "kind", "effectgate_version", "created_at",
    "transaction_id", "source", "consistency", "files"
  ]) ||
      manifest.schema_version !== "1.0.0" ||
      manifest.kind !== "effectgate_state_backup" ||
      manifest.effectgate_version !== EFFECTGATE_VERSION ||
      `${canonicalJson(manifest)}\n` !== manifestText ||
      !exact(manifest.source, [
        "config_file", "configuration_digest", "state_directory",
        "state_marker_digest"
      ]) ||
      !exact(manifest.consistency, [
        "database_cut", "database_copy", "database_journal_mode",
        "cas_state"
      ]) ||
      manifest.consistency.database_cut !==
        "sqlite_attached_begin_immediate" ||
      manifest.consistency.database_copy !== "sqlite_online_backup" ||
      manifest.consistency.database_journal_mode !== "delete" ||
      manifest.consistency.cas_state !== "not_configured" ||
      !Array.isArray(manifest.files) ||
      manifest.files.length !== databaseNames.length + 2) {
    throw new Error("backup manifest is incompatible");
  }
  try {
    if (new Date(manifest.created_at).toISOString() !== manifest.created_at) {
      throw new Error();
    }
  } catch {
    throw new Error("backup manifest timestamp is invalid");
  }

  const records = new Map();
  for (const record of manifest.files) {
    if (!exact(record, ["kind", "path", "bytes", "digest"]) ||
        !Number.isSafeInteger(record.bytes) || record.bytes < 0 ||
        !/^sha256:[a-f0-9]{64}$/u.test(record.digest) ||
        records.has(record.path)) {
      throw new Error("backup file record is invalid");
    }
    records.set(record.path, record);
  }
  const expected = [
    ["configuration.json", "configuration"],
    ["cas-manifest.json", "cas_manifest"],
    ...databaseNames.map((name) => [`databases/${name}`, "sqlite"])
  ];
  for (const [path, kind] of expected) {
    const record = records.get(path);
    const file = join(backupDirectory, ...path.split("/"));
    const metadata = lstatSync(file);
    if (!record || record.kind !== kind || !metadata.isFile() ||
        metadata.isSymbolicLink() || metadata.size !== record.bytes ||
        await fileDigest(file) !== record.digest ||
        (kind === "sqlite" && databaseIntegrity(file) !== "pass")) {
      throw new Error("backup file verification failed");
    }
  }

  const configurationText = readBounded(
    join(backupDirectory, "configuration.json"),
    64 * 1024
  );
  let configuration;
  try {
    configuration = normalizeSkillMcpConfig(JSON.parse(configurationText));
  } catch {
    throw new Error("backup configuration is invalid");
  }
  if (`${canonicalJson(configuration)}\n` !== configurationText ||
      manifest.transaction_id !== configuration.transaction_id ||
      manifest.source.configuration_digest !== digest(configurationText)) {
    throw new Error("backup configuration binding mismatch");
  }
  const casText = readBounded(
    join(backupDirectory, "cas-manifest.json"),
    16 * 1024
  );
  let cas;
  try {
    cas = JSON.parse(casText);
  } catch {
    throw new Error("backup CAS manifest is invalid");
  }
  if (!exact(cas, ["schema_version", "kind", "state", "objects"]) ||
      cas.schema_version !== "1.0.0" ||
      cas.kind !== "effectgate_cas_manifest" ||
      cas.state !== "not_configured" ||
      !Array.isArray(cas.objects) || cas.objects.length !== 0 ||
      `${canonicalJson(cas)}\n` !== casText) {
    throw new Error("backup CAS manifest is incompatible");
  }
  return {
    backupDirectory,
    configuration,
    databaseNames,
    manifestDigest
  };
}

export async function restoreStateBackup({
  backupDirectory,
  configFile,
  stateDirectory
} = {}) {
  if (typeof backupDirectory !== "string" ||
      backupDirectory.length === 0 ||
      Buffer.byteLength(backupDirectory, "utf8") > 1024 ||
      backupDirectory.includes("\0") ||
      backupDirectory !== backupDirectory.normalize("NFC")) {
    throw new TypeError("invalid restore request");
  }
  const inspected = await inspectStateBackup(backupDirectory);
  const restoredConfigFile = freshPath(configFile);
  const restoredStateDirectory = freshPath(stateDirectory);
  const skillRoot = realpathSync(inspected.configuration.skill_root);
  if (pathContains(restoredStateDirectory, restoredConfigFile) ||
      pathContains(inspected.backupDirectory, restoredConfigFile) ||
      pathContains(inspected.backupDirectory, restoredStateDirectory) ||
      pathContains(restoredStateDirectory, inspected.backupDirectory) ||
      pathContains(restoredStateDirectory, skillRoot) ||
      pathContains(skillRoot, restoredStateDirectory)) {
    throw new Error("restore paths overlap protected data");
  }
  const configuration = normalizeSkillMcpConfig({
    ...inspected.configuration,
    state_directory: restoredStateDirectory
  });
  importSkillSource({
    root: configuration.skill_root,
    paths: SKILL_SOURCE_PATHS,
    expectedDigest: configuration.skill_source_digest
  });

  const configPart = `${restoredConfigFile}.restore.part`;
  if (existsSync(configPart)) {
    throw new Error("restore staging file already exists");
  }
  mkdirSync(restoredStateDirectory, { mode: 0o700 });
  let invalidatedApprovals = 0;
  let recovered = [];
  try {
    for (const name of inspected.databaseNames) {
      const source = join(inspected.backupDirectory, "databases", name);
      const target = join(restoredStateDirectory, name);
      copyFileSync(source, target, fsConstants.COPYFILE_EXCL);
      chmodSync(target, 0o600);
      syncFile(target);
      if (databaseIntegrity(target) !== "pass" ||
          await fileDigest(target) !== await fileDigest(source)) {
        throw new Error("restored database verification failed");
      }
    }
    const operationFile = join(
      restoredStateDirectory,
      "effect-operations.db"
    );
    if (existsSync(operationFile)) {
      const approvals = new ApprovalLeaseStore({ file: operationFile });
      try {
        invalidatedApprovals = approvals.revoke({
          sessionId: configuration.transaction_id
        }).revoked;
      } finally {
        approvals.close();
      }
      const journal = new EffectOperationJournal({ file: operationFile });
      try {
        recovered = journal.recover();
      } finally {
        journal.close();
      }
    }
    for (const name of inspected.databaseNames) {
      if (databaseIntegrity(
        join(restoredStateDirectory, name)
      ) !== "pass") {
        throw new Error("restored database integrity check failed");
      }
    }
    const marker = {
      schema_version: "1.0.0",
      kind: "effectgate_state_directory",
      config_file: restoredConfigFile,
      state_directory: restoredStateDirectory,
      transaction_id: configuration.transaction_id
    };
    writeExclusive(
      join(restoredStateDirectory, ".effectgate-state.json"),
      `${canonicalJson(marker)}\n`
    );
    writeExclusive(
      configPart,
      `${JSON.stringify(configuration, null, 2)}\n`
    );
    renameSync(configPart, restoredConfigFile);
  } catch (error) {
    rmSync(configPart, { force: true });
    rmSync(restoredStateDirectory, { recursive: true, force: true });
    throw error;
  }
  return {
    schema_version: "1.0.0",
    command: "restore",
    status: "restored",
    config_file: restoredConfigFile,
    state_directory: restoredStateDirectory,
    transaction_id: configuration.transaction_id,
    manifest_digest: inspected.manifestDigest,
    database_count: inspected.databaseNames.length,
    invalidated_approval_records: invalidatedApprovals,
    invalidated_cursor_count: 0,
    cursor_state: "process_local_not_restored",
    recovered_operation_count: recovered.length,
    reconciliation_required: recovered.filter(
      (operation) => operation.state === "uncertain"
    ).length
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
      const copied = new DatabaseSync(partFile);
      try {
        if (copied.prepare("PRAGMA journal_mode=DELETE")
          .get().journal_mode !== "delete") {
          throw new Error("backup database journal normalization failed");
        }
      } finally {
        copied.close();
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
      database_journal_mode: "delete",
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
