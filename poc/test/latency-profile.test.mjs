import assert from "node:assert/strict";
import test from "node:test";

import {
  profileProxyLatency
} from "../src/benchmark/latency-profile.mjs";

test("latency profiler compares warm native and typed paths", async () => {
  const result = await profileProxyLatency({ samples: 4, warmups: 1 });
  assert.equal(result.kind, "effectgate_proxy_latency_profile");
  assert.equal(result.samples, 4);
  assert.equal(result.warmups, 1);
  assert.match(result.node_version, /^v\d+/u);
  for (const operation of [result.ping, result.small_read]) {
    assert.ok(operation.native.median_ms > 0);
    assert.ok(operation.native.p95_ms > 0);
    assert.ok(operation.typed.median_ms > 0);
    assert.ok(operation.typed.p95_ms > 0);
    assert.ok(Number.isFinite(operation.added_median_ms));
    assert.ok(Number.isFinite(operation.relative_median_overhead));
  }
  assert.ok(Number.isFinite(result.tool_path_incremental_added_median_ms));
  await assert.rejects(
    profileProxyLatency({ samples: 0 }),
    TypeError
  );
});
