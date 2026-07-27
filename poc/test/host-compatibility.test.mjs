import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  decideNativeDeferral,
  loadHostCompatibilityEvidence,
  withNativeDeferralMetadata
} from "../src/proxy/host-compatibility.mjs";
import {
  FIXTURE_TOOL,
  MCP_VERSION
} from "../src/proxy/effectgate.mjs";
import { RpcProcess } from "../src/testkit/rpc-process.mjs";

function digest(value) {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const CLAUDE_QUALIFICATION = fileURLToPath(new URL(
  "../evidence/claude-code-tool-search-2.1.220.json",
  import.meta.url
));
const CLAUDE_HOST_EVIDENCE = fileURLToPath(new URL(
  "../evidence/host-compatibility-claude-code-2.1.220.json",
  import.meta.url
));

function manifest(overrides = {}) {
  return {
    kind: "effectgate_host_compatibility",
    schema_version: "1.0.0",
    client: {
      name: "qualified-host",
      version: "1.2.3",
      build_digest: digest("qualified-host-build")
    },
    tool_search: {
      state: "enabled_observed",
      configuration_digest: digest("tool-search-enabled")
    },
    evidence_state: "pass",
    observed_at: "2026-07-27T00:00:00.000Z",
    expires_at: "2026-08-27T00:00:00.000Z",
    ...overrides
  };
}

function evidenceFile(value = manifest()) {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-host-evidence-"));
  const file = join(directory, "host.json");
  const text = JSON.stringify(value);
  writeFileSync(file, text);
  return {
    directory,
    file,
    text,
    close() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("host evidence enables metadata only for an exact qualified client", () => {
  const files = evidenceFile();
  try {
    const evidence = loadHostCompatibilityEvidence(files.file);
    assert.equal(evidence.evidence_digest, digest(files.text));
    const decision = decideNativeDeferral(evidence, {
      clientInfo: { name: "qualified-host", version: "1.2.3" },
      clientBuildDigest: digest("qualified-host-build"),
      now: () => Date.parse("2026-07-28T00:00:00.000Z")
    });
    assert.deepEqual(decision, {
      eligible: true,
      reason: "qualified",
      evidence_digest: digest(files.text),
      evidence_state: "pass",
      tool_search_state: "enabled_observed"
    });
    const contract = withNativeDeferralMetadata(
      { ...FIXTURE_TOOL, _meta: { retained: true } },
      decision
    );
    assert.deepEqual(contract.inputSchema, FIXTURE_TOOL.inputSchema);
    assert.equal(contract._meta.retained, true);
    assert.deepEqual(contract._meta["dev.effectgate/nativeDeferral"], {
      eligible: true,
      evidence_digest: digest(files.text)
    });
  } finally {
    files.close();
  }
});

test("EG-014B retains exact-build Claude Tool Search evidence", () => {
  const qualification = JSON.parse(readFileSync(CLAUDE_QUALIFICATION, "utf8"));
  const evidence = loadHostCompatibilityEvidence(CLAUDE_HOST_EVIDENCE);
  assert.equal(qualification.task_id, "EG-014B");
  assert.equal(qualification.evidence_state, "pass");
  assert.equal(qualification.observation.tool_search_call_count, 1);
  assert.equal(qualification.observation.selected_tool_call_count, 1);
  assert.equal(qualification.observation.probe_result_exact, true);
  assert.equal(qualification.usage_guard.is_using_overage, false);
  assert.equal(
    digest(JSON.stringify(qualification.configuration)),
    qualification.configuration_digest
  );
  assert.equal(evidence.manifest.client.version, "2.1.220");
  assert.equal(
    evidence.manifest.client.build_digest,
    qualification.client.build_digest
  );
  assert.equal(evidence.manifest.tool_search.state, "enabled_observed");
});

test("host evidence fails closed on mismatch, weak state, expiry, or corruption", () => {
  const files = evidenceFile();
  const partialFiles = evidenceFile(manifest({ evidence_state: "partial" }));
  try {
    const evidence = loadHostCompatibilityEvidence(files.file);
    const options = {
      clientInfo: { name: "qualified-host", version: "1.2.3" },
      clientBuildDigest: digest("qualified-host-build"),
      now: () => Date.parse("2026-07-28T00:00:00.000Z")
    };
    assert.equal(
      decideNativeDeferral(evidence, {
        ...options,
        clientBuildDigest: digest("different-build")
      }).reason,
      "client_identity_mismatch"
    );
    assert.equal(
      decideNativeDeferral(
        loadHostCompatibilityEvidence(partialFiles.file),
        options
      ).reason,
      "support_not_proven"
    );
    assert.equal(
      decideNativeDeferral(evidence, {
        ...options,
        now: () => Date.parse("2026-08-28T00:00:00.000Z")
      }).reason,
      "evidence_expired"
    );
    assert.deepEqual(decideNativeDeferral(undefined), {
      eligible: false,
      reason: "evidence_not_configured"
    });

    writeFileSync(files.file, JSON.stringify({
      ...manifest(),
      unexpected: "must fail"
    }));
    assert.throws(
      () => loadHostCompatibilityEvidence(files.file),
      /failed validation/
    );
    writeFileSync(files.file, Buffer.from([0xff]));
    assert.throws(
      () => loadHostCompatibilityEvidence(files.file),
      /failed validation/
    );
  } finally {
    files.close();
    partialFiles.close();
  }
});

test("proxy pins qualified native deferral and rejects a client mismatch", async (context) => {
  const value = manifest({
    expires_at: "2099-08-27T00:00:00.000Z"
  });
  const files = evidenceFile(value);
  const matching = new RpcProcess([
    "mcp",
    "serve",
    "--host-evidence",
    files.file
  ]);
  const mismatched = new RpcProcess([
    "mcp",
    "serve",
    "--host-evidence",
    files.file
  ]);
  context.after(async () => {
    await Promise.all([matching.stop(), mismatched.stop()]);
    files.close();
  });

  const initialize = (process, version) =>
    process.request("initialize", {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: { name: "qualified-host", version },
      _meta: {
        "dev.effectgate/clientBuildDigest": digest("qualified-host-build")
      }
    });

  const qualified = await initialize(matching, "1.2.3");
  assert.equal(
    qualified.result._meta["dev.effectgate/nativeDeferral"].eligible,
    true
  );
  matching.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const qualifiedCatalog = await matching.request("tools/list");
  assert.deepEqual(
    qualifiedCatalog.result.tools[0]._meta[
      "dev.effectgate/nativeDeferral"
    ],
    {
      eligible: true,
      evidence_digest: digest(JSON.stringify(value))
    }
  );
  assert.deepEqual(
    qualifiedCatalog.result.tools[0].inputSchema,
    FIXTURE_TOOL.inputSchema
  );

  const rejected = await initialize(mismatched, "9.9.9");
  assert.equal(
    rejected.result._meta["dev.effectgate/nativeDeferral"].reason,
    "client_identity_mismatch"
  );
  mismatched.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  const rejectedCatalog = await mismatched.request("tools/list");
  assert.equal(rejectedCatalog.result.tools[0]._meta, undefined);
});
