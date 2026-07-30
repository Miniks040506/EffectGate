import {
  constants,
  accessSync,
  existsSync,
  mkdirSync,
  writeFileSync
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";

import { EFFECTGATE_VERSION } from "../proxy/mcp-contract.mjs";
import {
  SKILL_SOURCE_PATHS,
  loadSkillMcpConfig,
  normalizeSkillMcpConfig
} from "../skill/skill-runtime-config.mjs";
import { importSkillSource } from "../skill/source-import.mjs";
import {
  STDIO_EFFECT_DRIVER,
  probeReviewedStdioEffectBackend,
  stdioEffectAdapterSourceDigest
} from "../skill/stdio-effect-adapter.mjs";
import { operatorRpcRequest } from "./operator-rpc.mjs";
import {
  databaseIntegrity,
  inspectConfiguredReceipt,
  inspectConfiguredResolution,
  inspectConfiguredStatus,
  manuallyResolveConfiguredOperation,
  recoveryBacklog
} from "./operator-state.mjs";

const USAGE = "Usage: effectgate.mjs init --config FILE --state DIRECTORY " +
  "--skill-root DIRECTORY --target PATH --transaction ID " +
  "(--dry-run | --apply) [--json] | doctor|status --config FILE [--json] | " +
  "receipt --config FILE --id ID [--json] | approve --config FILE " +
  "--operation ID [--approver ID --intent DIGEST --yes | --deny] [--json] " +
  "| resolve --config FILE --operation ID [--reconcile | " +
  "--manual --receipt ID --note TEXT --yes] [--json]";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const VALUE_OPTIONS = Object.freeze({
  "--config": "configFile",
  "--state": "stateDirectory",
  "--skill-root": "skillRoot",
  "--target": "targetPath",
  "--transaction": "transactionId",
  "--id": "id",
  "--operation": "operationId",
  "--receipt": "receiptId",
  "--approver": "approverId",
  "--intent": "intentDigest",
  "--note": "note"
});
const FLAG_OPTIONS = Object.freeze({
  "--dry-run": "dryRun",
  "--apply": "apply",
  "--deny": "deny",
  "--manual": "manual",
  "--reconcile": "reconcile",
  "--yes": "yes",
  "--json": "json"
});
const ALLOWED = Object.freeze({
  init: new Set([
    "configFile", "stateDirectory", "skillRoot", "targetPath",
    "transactionId", "dryRun", "apply", "json"
  ]),
  doctor: new Set(["configFile", "json"]),
  status: new Set(["configFile", "json"]),
  receipt: new Set(["configFile", "id", "json"]),
  approve: new Set([
    "configFile", "operationId", "approverId", "intentDigest",
    "yes", "deny", "json"
  ]),
  resolve: new Set([
    "configFile", "operationId", "receiptId", "manual", "reconcile",
    "note", "yes", "json"
  ])
});

function fail() {
  throw new TypeError(USAGE);
}

function bounded(value, maximum = 1024) {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= maximum &&
    !value.includes("\0") && value === value.normalize("NFC");
}

function parse(args) {
  const command = args[0];
  if (!Object.hasOwn(ALLOWED, command)) fail();
  const values = { command };
  for (let index = 1; index < args.length; index += 1) {
    const option = args[index];
    const key = VALUE_OPTIONS[option] ?? FLAG_OPTIONS[option];
    if (!key || !ALLOWED[command].has(key) ||
        Object.hasOwn(values, key)) fail();
    if (Object.hasOwn(FLAG_OPTIONS, option)) {
      values[key] = true;
    } else {
      const value = args[++index];
      if (!bounded(value)) fail();
      values[key] = value;
    }
  }
  if (!bounded(values.configFile) ||
      (command === "init" &&
        (!bounded(values.stateDirectory) || !bounded(values.skillRoot) ||
          !bounded(values.targetPath, 512) ||
          !IDENTIFIER.test(values.transactionId ?? "") ||
          values.dryRun === values.apply)) ||
      (command === "receipt" && !IDENTIFIER.test(values.id ?? ""))) fail();
  if (command === "approve" &&
      (!IDENTIFIER.test(values.operationId ?? "") ||
        (values.yes && values.deny) ||
        (values.yes &&
          (!IDENTIFIER.test(values.approverId ?? "") ||
            !DIGEST.test(values.intentDigest ?? ""))) ||
        (!values.yes &&
          (values.approverId !== undefined ||
            values.intentDigest !== undefined)))) fail();
  const resolutionAction = [
    values.manual, values.yes, values.note !== undefined,
    values.receiptId !== undefined
  ].filter(Boolean).length;
  if (command === "resolve" &&
      (!IDENTIFIER.test(values.operationId ?? "") ||
        (values.reconcile && resolutionAction !== 0) ||
        ![0, 4].includes(resolutionAction) ||
        (resolutionAction === 4 &&
          !IDENTIFIER.test(values.receiptId ?? "")))) fail();
  return values;
}

function nearestExisting(path) {
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return current;
}

function init(options) {
  const configFile = resolve(options.configFile);
  if (existsSync(configFile)) {
    throw new Error("configuration file already exists");
  }
  const source = importSkillSource({
    root: resolve(options.skillRoot),
    paths: SKILL_SOURCE_PATHS
  });
  const config = normalizeSkillMcpConfig({
    schema_version: "1.0.0",
    driver: STDIO_EFFECT_DRIVER,
    state_directory: resolve(options.stateDirectory),
    skill_root: resolve(options.skillRoot),
    skill_source_digest: source.source_digest,
    transaction_id: options.transactionId,
    principal_id: "local-operator",
    client_id: "local-mcp-client",
    target_path: options.targetPath,
    resource_scope: `repo:reviewed/path:${options.targetPath}`,
    backend_source_digest: stdioEffectAdapterSourceDigest(),
    approval_mode: "cli"
  });
  const created = {
    config_parent: !existsSync(dirname(configFile)),
    state_directory: !existsSync(config.state_directory)
  };
  if (options.apply) {
    mkdirSync(dirname(configFile), { recursive: true, mode: 0o700 });
    mkdirSync(config.state_directory, { recursive: true, mode: 0o700 });
    writeFileSync(configFile, `${JSON.stringify(config, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600
    });
  }
  return {
    schema_version: "1.0.0",
    command: "init",
    status: options.apply ? "applied" : "dry_run",
    config_file: configFile,
    state_directory: config.state_directory,
    skill_root: config.skill_root,
    transaction_id: config.transaction_id,
    driver: config.driver,
    target_path: config.target_path,
    skill_source_digest: config.skill_source_digest,
    backend_source_digest: config.backend_source_digest,
    would_create: created
  };
}

async function doctor(options) {
  const checks = [];
  const add = (name, status, detail) =>
    checks.push(detail === undefined ? { name, status } : {
      name, status, detail
    });
  let config;
  try {
    config = loadSkillMcpConfig(options.configFile);
    add("configuration", "pass", "schema 1.0.0");
  } catch {
    add("configuration", "fail", "invalid or unreadable");
    return {
      schema_version: "1.0.0", command: "doctor", status: "fail", checks
    };
  }
  add(
    "runtime",
    Number(process.versions.node.split(".")[0]) >= 24 ? "pass" : "fail",
    `EffectGate ${EFFECTGATE_VERSION}; Node ${process.versions.node}`
  );
  try {
    importSkillSource({
      root: config.skill_root,
      paths: SKILL_SOURCE_PATHS,
      expectedDigest: config.skill_source_digest
    });
    add("skill_source", "pass", "digest pinned");
  } catch {
    add("skill_source", "fail", "missing or digest drift");
  }
  try {
    accessSync(nearestExisting(config.state_directory), constants.W_OK);
    add("state_directory", "pass", "writable ancestor");
  } catch {
    add("state_directory", "fail", "no writable ancestor");
  }
  if (config.driver === STDIO_EFFECT_DRIVER) {
    try {
      await probeReviewedStdioEffectBackend({
        cwd: config.skill_root,
        expectedSourceDigest: config.backend_source_digest
      });
      add("backend", "pass", "exact stdio handshake");
    } catch {
      add("backend", "fail", "identity or reachability failure");
    }
  } else {
    add("backend", "warn", "memory fixture is process-local");
  }
  for (const [name, file] of [
    ["skill_database", "skill-events.db"],
    ["operation_database", "effect-operations.db"],
    ["backend_database", "stdio-effect-backend.db"]
  ]) {
    add(name, databaseIntegrity(join(config.state_directory, file)));
  }
  const backlog = recoveryBacklog(config);
  add("recovery_backlog", backlog === 0 ? "pass" : "warn", backlog);
  add(
    "approval_channel",
    config.approval_mode === "cli" ? "pass" : "warn",
    config.approval_mode === "cli"
      ? "single-use local CLI approval"
      : "not configured in preview"
  );
  add("token_counter", "pass", "built-in byte proxy");
  const status = checks.some((check) => check.status === "fail")
    ? "fail"
    : checks.some((check) => check.status === "warn") ? "warn" : "pass";
  return {
    schema_version: "1.0.0", command: "doctor", status, checks
  };
}

function status(options) {
  const config = loadSkillMcpConfig(options.configFile);
  importSkillSource({
    root: config.skill_root,
    paths: SKILL_SOURCE_PATHS,
    expectedDigest: config.skill_source_digest
  });
  return {
    schema_version: "1.0.0",
    command: "status",
    ...inspectConfiguredStatus(config)
  };
}

function receipt(options) {
  const config = loadSkillMcpConfig(options.configFile);
  return {
    schema_version: "1.0.0",
    command: "receipt",
    status: "found",
    receipt: inspectConfiguredReceipt(config, options.id)
  };
}

async function approve(options) {
  const config = loadSkillMcpConfig(options.configFile);
  const method = options.deny
    ? "approval.deny"
    : options.yes ? "approval.approve" : "approval.inspect";
  const approval = await operatorRpcRequest(config.state_directory, {
    schema_version: "1.0.0",
    method,
    operation_id: options.operationId,
    ...(options.yes
      ? {
          approver_id: options.approverId,
          intent_digest: options.intentDigest
        }
      : {})
  });
  if (!options.yes && !options.deny) {
    return {
      schema_version: "1.0.0",
      command: "approve",
      status: "confirmation_required",
      approval
    };
  }
  return {
    schema_version: "1.0.0",
    command: "approve",
    ...approval
  };
}

async function resolveOperation(options) {
  const config = loadSkillMcpConfig(options.configFile);
  if (options.reconcile) {
    const outcome = await operatorRpcRequest(config.state_directory, {
      schema_version: "1.0.0",
      method: "operation.reconcile",
      operation_id: options.operationId
    });
    return {
      schema_version: "1.0.0",
      command: "resolve",
      status: outcome.state,
      outcome
    };
  }
  if (!options.manual) {
    return {
      schema_version: "1.0.0",
      command: "resolve",
      status: "confirmation_required",
      resolution: inspectConfiguredResolution(
        config, options.operationId
      )
    };
  }
  return {
    schema_version: "1.0.0",
    command: "resolve",
    ...manuallyResolveConfiguredOperation(
      config, options.operationId, options.receiptId, options.note
    )
  };
}

function human(result) {
  if (result.command === "doctor") {
    return [
      `EffectGate doctor: ${result.status}`,
      ...result.checks.map((check) =>
        `[${check.status}] ${check.name}` +
        (check.detail === undefined ? "" : `: ${check.detail}`))
    ].join("\n");
  }
  if (result.command === "status") {
    return `Transaction ${result.transaction_id}: ${result.status}\n` +
      `Operations: ${result.operations.length}; receipts: ` +
      `${result.receipt_count}; recovery backlog: ${result.recovery_backlog}`;
  }
  if (result.command === "init") {
    return `EffectGate configuration ${result.status}: ${result.config_file}`;
  }
  if (result.command === "approve") {
    const operationId =
      result.operation_id ?? result.approval.operation_id;
    const review = result.status === "confirmation_required"
      ? `\nExact arguments:\n${
          JSON.stringify(result.approval.exact_arguments, null, 2)
        }\nApprove this intent with --intent ${
          result.approval.intent_digest
        }`
      : "";
    return `Approval ${result.status}: ${operationId}${review}`;
  }
  if (result.command === "resolve") {
    const operationId =
      result.operation_id ?? result.resolution?.operation_id ??
        result.outcome.operation_id;
    return `Resolution ${result.status}: ${operationId}`;
  }
  return JSON.stringify(result.receipt, null, 2);
}

export async function operatorCommand(args) {
  const options = parse(args);
  if (options.command === "init") return init(options);
  if (options.command === "doctor") return doctor(options);
  if (options.command === "status") return status(options);
  if (options.command === "receipt") return receipt(options);
  if (options.command === "approve") return approve(options);
  return resolveOperation(options);
}

export async function runOperatorCli(args, output = process.stdout) {
  const result = await operatorCommand(args);
  output.write(
    args.includes("--json")
      ? `${JSON.stringify(result)}\n`
      : `${human(result)}\n`
  );
  return result.status === "fail" ? 1 : 0;
}
