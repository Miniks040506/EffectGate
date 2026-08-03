import assert from "node:assert/strict";
import test from "node:test";

import {
  qualifyTargetCorpusFixture
} from "../src/benchmark/target-corpus-fixture.mjs";

const COMMIT = "b".repeat(40);

test("exact target corpora pass bounded context-plane qualification", () => {
  assert.throws(
    () => qualifyTargetCorpusFixture({ sourceCommit: "short" }),
    /full source commit/
  );
  const qualification = qualifyTargetCorpusFixture({ sourceCommit: COMMIT });
  assert.equal(Object.isFrozen(qualification), true);
  assert.equal(qualification.verdict, "pass");
  assert.equal(qualification.release_gate_eligible, false);
  assert.deepEqual(qualification.checks, {
    all_context_tasks_pass: true,
    exact_dataset_count: true
  });
  assert.deepEqual(qualification.transport, {
    exact_corpus_mcp_stdio_qualified: false,
    jsonl_frame_limit_bytes: 1024 * 1024,
    reason: "mcp_stdio_requires_bounded_frames"
  });
  assert.deepEqual(
    qualification.tasks.map(({ dataset_id, bytes, artifact_digest }) => ({
      dataset_id,
      bytes,
      artifact_digest
    })),
    [
      {
        dataset_id: "LOG_80K",
        bytes: 320000,
        artifact_digest:
          "sha256:09f4ba2216ad95f6c8a4aa238571b2f914837e5e73961ea76a8f71b4f6dd92d5"
      },
      {
        dataset_id: "JSON_50K",
        bytes: 4438954,
        artifact_digest:
          "sha256:717a2d36057ac18bc45670a2f2c946673a2e6412afa0e0165e655bccc5fcfd57"
      },
      {
        dataset_id: "JSONL_25MB",
        bytes: 25 * 1024 * 1024,
        artifact_digest:
          "sha256:98fc08486d402182aef01ad8892793218605de750fda5b1d3e09199c63ccadca"
      },
      {
        dataset_id: "CSV_100K",
        bytes: 3489067,
        artifact_digest:
          "sha256:d45514247b259e554b4e562337cba7ca620f890f94b2f5176a34f2aaddf15ced"
      }
    ]
  );
  for (const task of qualification.tasks) {
    assert.equal(task.verdict, "pass");
    assert.ok(Object.values(task.checks).every(Boolean));
    assert.ok(task.measurements.first_view_bytes <= 4096);
    assert.ok(task.measurements.first_view_reduction >= 0.70);
  }
  assert.equal(
    qualification.tasks.find(
      ({ dataset_id }) => dataset_id === "JSONL_25MB"
    ).shape.malformed_records,
    3
  );
});
