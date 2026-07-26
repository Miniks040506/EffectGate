import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { resolve } from "node:path";

const MAX_EVIDENCE_BYTES = 16 * 1024;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const EVIDENCE_STATES = new Set([
  "not_run",
  "partial",
  "pass",
  "fail",
  "stale"
]);
const TOOL_SEARCH_STATES = new Set([
  "enabled_observed",
  "disabled_observed",
  "unknown"
]);
const ROOT_KEYS = new Set([
  "kind",
  "schema_version",
  "client",
  "tool_search",
  "evidence_state",
  "observed_at",
  "expires_at"
]);
const CLIENT_KEYS = new Set(["name", "version", "build_digest"]);
const TOOL_SEARCH_KEYS = new Set(["state", "configuration_digest"]);

function exactObject(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.size &&
    Object.keys(value).every((key) => keys.has(key))
  );
}

function boundedName(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9_.-]{1,128}$/u.test(value)
  );
}

function timestamp(value) {
  if (typeof value !== "string") return null;
  try {
    const milliseconds = Date.parse(value);
    return new Date(milliseconds).toISOString() === value
      ? milliseconds
      : null;
  } catch {
    return null;
  }
}

function freezeManifest(value) {
  return Object.freeze({
    ...value,
    client: Object.freeze({ ...value.client }),
    tool_search: Object.freeze({ ...value.tool_search })
  });
}

export function loadHostCompatibilityEvidence(file) {
  if (
    typeof file !== "string" ||
    file.length < 1 ||
    Buffer.byteLength(file, "utf8") > 1024 ||
    file.includes("\0")
  ) {
    throw new TypeError("invalid host compatibility evidence configuration");
  }
  const evidenceFile = resolve(file);
  let bytes;
  let value;
  try {
    bytes = fs.readFileSync(evidenceFile);
    if (bytes.length < 1 || bytes.length > MAX_EVIDENCE_BYTES) {
      throw new Error();
    }
    value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new TypeError("host compatibility evidence failed validation");
  }

  const observedAt = timestamp(value?.observed_at);
  const expiresAt = timestamp(value?.expires_at);
  if (
    !exactObject(value, ROOT_KEYS) ||
    value.kind !== "effectgate_host_compatibility" ||
    value.schema_version !== "1.0.0" ||
    !exactObject(value.client, CLIENT_KEYS) ||
    !boundedName(value.client.name) ||
    !boundedName(value.client.version) ||
    !DIGEST_PATTERN.test(value.client.build_digest) ||
    !exactObject(value.tool_search, TOOL_SEARCH_KEYS) ||
    !TOOL_SEARCH_STATES.has(value.tool_search.state) ||
    !DIGEST_PATTERN.test(value.tool_search.configuration_digest) ||
    !EVIDENCE_STATES.has(value.evidence_state) ||
    observedAt === null ||
    expiresAt === null ||
    expiresAt <= observedAt
  ) {
    throw new TypeError("host compatibility evidence failed validation");
  }

  return Object.freeze({
    file: evidenceFile,
    manifest: freezeManifest(value),
    evidence_digest: `sha256:${createHash("sha256")
      .update(bytes)
      .digest("hex")}`
  });
}

export function decideNativeDeferral(
  evidence,
  { clientInfo, clientBuildDigest, now = Date.now } = {}
) {
  if (typeof now !== "function") {
    throw new TypeError("invalid native deferral decision configuration");
  }
  if (evidence === undefined) {
    return Object.freeze({
      eligible: false,
      reason: "evidence_not_configured"
    });
  }
  const manifest = evidence.manifest;
  const common = {
    evidence_digest: evidence.evidence_digest,
    evidence_state: manifest.evidence_state,
    tool_search_state: manifest.tool_search.state
  };
  if (Date.parse(manifest.expires_at) <= now()) {
    return Object.freeze({
      eligible: false,
      reason: "evidence_expired",
      ...common
    });
  }
  if (
    manifest.evidence_state !== "pass" ||
    manifest.tool_search.state !== "enabled_observed"
  ) {
    return Object.freeze({
      eligible: false,
      reason: "support_not_proven",
      ...common
    });
  }
  if (
    clientInfo === null ||
    typeof clientInfo !== "object" ||
    Array.isArray(clientInfo) ||
    clientInfo.name !== manifest.client.name ||
    clientInfo.version !== manifest.client.version ||
    clientBuildDigest !== manifest.client.build_digest
  ) {
    return Object.freeze({
      eligible: false,
      reason: "client_identity_mismatch",
      ...common
    });
  }
  return Object.freeze({
    eligible: true,
    reason: "qualified",
    ...common
  });
}

export function withNativeDeferralMetadata(contract, decision) {
  if (
    contract === null ||
    typeof contract !== "object" ||
    Array.isArray(contract) ||
    decision?.eligible !== true
  ) {
    return contract;
  }
  return {
    ...contract,
    _meta: {
      ...(contract._meta !== null &&
      typeof contract._meta === "object" &&
      !Array.isArray(contract._meta)
        ? contract._meta
        : {}),
      "dev.effectgate/nativeDeferral": Object.freeze({
        eligible: true,
        evidence_digest: decision.evidence_digest
      })
    }
  };
}
