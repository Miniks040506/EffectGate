import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { CorruptSkillEventStoreError, SkillEventStore } from "../src/skill/skill-event-store.mjs";
import { SkillSourceError } from "../src/skill/source-import.mjs";
const digest = (character) => `sha256:${character.repeat(64)}`;

function databaseFile() {
  const directory = mkdtempSync(join(tmpdir(), "effectgate-events-"));
  return {
    directory,
    file: join(directory, "skill.db"),
    close() {
      rmSync(directory, { recursive: true, force: true });
    }
  };
}

test("skill events survive reopen and remain ordered and immutable", () => {
  const files = databaseFile();
  let store = new SkillEventStore({ file: files.file });
  try {
    const header = {
      transactionId: "transaction-1",
      passportDigest: digest("a"),
      skillDigest: digest("b"),
      initialPhase: "inspect",
      createdAt: "2026-07-28T00:00:00.000Z"
    };
    store.startTransaction(header);
    const first = store.append({
      transactionId: "transaction-1",
      kind: "capsule_activated",
      phase: "inspect",
      phaseRevision: 1,
      payload: { capsule_digest: digest("c") },
      observedAt: "2026-07-28T00:01:00.000Z"
    });
    const second = store.append({
      transactionId: "transaction-1",
      kind: "phase_receipt",
      phase: "inspect",
      phaseRevision: 1,
      payload: { status: "completed", next_phase: "modify" },
      observedAt: "2026-07-28T00:02:00.000Z"
    });
    assert.equal(second.previous_digest, first.event_digest);
    assert.throws(
      () => store.startTransaction(header),
      (error) => error instanceof SkillSourceError
    );

    store.close();
    store = new SkillEventStore({ file: files.file });
    const loaded = store.load("transaction-1");
    assert.equal(loaded.events.length, 2);
    assert.equal(loaded.events[1].payload.next_phase, "modify");
    assert.ok(Object.isFrozen(loaded.events[0]));
    store.close();

    const tamper = new DatabaseSync(files.file);
    tamper.exec("DROP TRIGGER skill_phase_events_no_update");
    tamper.prepare(`UPDATE skill_phase_events SET payload_json=?
      WHERE transaction_id=? AND sequence=2`)
      .run('{"status":"forged"}', "transaction-1");
    tamper.close();

    store = new SkillEventStore({ file: files.file });
    assert.throws(
      () => store.load("transaction-1"),
      CorruptSkillEventStoreError
    );
  } finally {
    try {
      store.close();
    } catch {}
    files.close();
  }
});
