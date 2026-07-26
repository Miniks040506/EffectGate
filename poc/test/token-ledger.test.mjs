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

import {
  CorruptTokenLedgerError,
  TokenLedger
} from "../src/budget/token-ledger.mjs";
import { BYTE_PROXY_COUNTER } from "../src/budget/token-counter.mjs";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-ledger-test-"));
  const file = join(directory, "tokens.jsonl");
  const options = {
    file,
    runId: "run_fixture",
    sessionId: "sess_fixture",
    now: () => Date.parse("2026-07-26T00:00:00.000Z")
  };
  return {
    directory,
    file,
    options,
    close() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("token ledger persists provenance and recomputable byte-proxy counts", () => {
  const files = fixture();
  try {
    const secret = "sk-ledger-must-not-store-this-value";
    const bytes = Buffer.byteLength(secret, "utf8");
    const tokenCount = BYTE_PROXY_COUNTER.measure({ content: secret });
    const ledger = new TokenLedger(files.options);

    ledger.append({
      stage: "first_view",
      direction: "to_host",
      tokenCount,
      bytes,
      artifactId: `art_${"a".repeat(64)}`,
      viewId: "view_fixture_identifier",
      category: "context_view_tokens_emitted"
    });
    const snapshot = ledger.snapshot();
    const unsigned = { ...snapshot };
    delete unsigned.integrity_digest;

    assert.equal(snapshot.entries.length, 1);
    assert.equal(snapshot.entries[0].token_count.value, Math.ceil(bytes / 4));
    assert.equal(
      snapshot.summary.measurement_basis_groups.byte_proxy,
      Math.ceil(bytes / 4)
    );
    assert.equal(
      snapshot.integrity_digest,
      `sha256:${createHash("sha256")
        .update(JSON.stringify(unsigned))
        .digest("hex")}`
    );
    assert.doesNotMatch(readFileSync(files.file, "utf8"), /must-not-store/);
    assert.equal(ledger.verify(), snapshot.integrity_digest);
    ledger.close();

    const reopened = new TokenLedger(files.options);
    assert.deepEqual(reopened.snapshot(), snapshot);
    reopened.close();
  } finally {
    files.close();
  }
});

test("token ledger rejects unsafe metadata and inconsistent measurements", () => {
  const files = fixture();
  try {
    const ledger = new TokenLedger(files.options);
    const measured = BYTE_PROXY_COUNTER.measure({ content: "safe" });

    assert.throws(
      () =>
        ledger.append({
          stage: "first_view",
          direction: "to_host",
          tokenCount: measured,
          bytes: 4,
          category: "secret=do-not-store"
        }),
      /invalid token ledger entry/
    );
    assert.throws(
      () =>
        ledger.append({
          stage: "first_view",
          direction: "to_host",
          tokenCount: { ...measured, value: 999 },
          bytes: 4
        }),
      /invalid token ledger entry/
    );
    assert.equal(ledger.snapshot().entries.length, 0);
    ledger.close();
  } finally {
    files.close();
  }
});

test("token ledger fails closed on truncation, corruption, and identity drift", () => {
  const files = fixture();
  try {
    const ledger = new TokenLedger(files.options);
    const measured = BYTE_PROXY_COUNTER.measure({ content: "four" });
    ledger.append({
      stage: "backend_raw_result",
      direction: "from_host",
      tokenCount: measured,
      bytes: 4
    });

    const valid = readFileSync(files.file, "utf8");
    writeFileSync(files.file, valid.replace('"bytes":4', '"bytes":8'));
    assert.throws(() => ledger.verify(), CorruptTokenLedgerError);
    ledger.close();
    assert.throws(
      () => new TokenLedger(files.options),
      CorruptTokenLedgerError
    );

    writeFileSync(files.file, valid.slice(0, -1));
    assert.throws(
      () => new TokenLedger(files.options),
      CorruptTokenLedgerError
    );

    writeFileSync(files.file, valid);
    assert.throws(
      () =>
        new TokenLedger({
          ...files.options,
          sessionId: "sess_other"
        }),
      CorruptTokenLedgerError
    );
  } finally {
    files.close();
  }
});
