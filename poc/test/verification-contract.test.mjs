import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = JSON.parse(readFileSync(join(
  HERE, "..", "..", "contracts", "verification-probe.schema.json"
), "utf8"));

test("verification contract fixes read-only authority and strict budgets", () => {
  assert.equal(CONTRACT.additionalProperties, false);
  assert.equal(
    CONTRACT.properties.probe.properties.effect_class.const,
    "observe"
  );
  assert.deepEqual(
    CONTRACT.properties.kind.enum,
    [
      "lookup_by_idempotency_key",
      "lookup_by_fingerprint",
      "read_after_write",
      "resource_version_match"
    ]
  );
  assert.equal(
    CONTRACT.properties.limits.properties.max_attempts.maximum,
    10
  );
  assert.equal(
    CONTRACT.properties.limits.properties.max_result_bytes.maximum,
    262144
  );
  assert.equal(
    CONTRACT.properties.evidence.properties.redaction.const,
    "digest_only"
  );
  assert.ok(CONTRACT.required.includes("qualification_evidence_digest"));
  assert.ok(CONTRACT.required.includes("descriptor_digest"));
});
