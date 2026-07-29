# EffectGate preview

This dependency-free Node.js preview proves two narrow paths:

```text
small typed result  -> unchanged MCP result
large text result   -> temporary filesystem CAS -> redacted view
other large result  -> serialized JSON in CAS -> bounded view
opaque/unknown data -> retained in CAS -> metadata-only unavailable view
retained artifact   -> fetch / literal search / JSON or JSONL projection
                    -> CSV or TSV projection / Markdown heading extraction
```

It remains fixture-only. The configured `memory-patch` profile exercises a
protected verified effect, but arbitrary backends, real secret-bearing data,
and production use remain disabled.

The configured profile reopens its SQLite journals on startup, reconciles an
interrupted dispatch without invoking it again, and publishes no effect tool
after its one-phase transaction completes.

## Run

```powershell
cd poc
npm test
npm start
```

Point an MCP stdio client at:

```text
node /absolute/path/to/EffectGate/poc/src/proxy/effectgate.mjs mcp serve
```

Serve the reviewed verified-effect fixture described in the root README:

```text
node /absolute/path/to/EffectGate/poc/src/proxy/effectgate.mjs mcp skill serve --config /absolute/path/to/effectgate.json
```

Optionally lower the default 262,144-token local output ceiling:

```text
node /absolute/path/to/EffectGate/poc/src/proxy/effectgate.mjs mcp serve --max-session-emitted-tokens 8192
```

Persist safe token provenance for one proxy session with:

```text
node /absolute/path/to/EffectGate/poc/src/proxy/effectgate.mjs mcp serve --token-ledger /absolute/path/to/tokens.jsonl
```

Attach a previously qualified host-evidence manifest with:

```text
node effectgate.mjs mcp serve --host-evidence /absolute/path/to/host-evidence.json
```

Manifest shape:

```json
{
  "kind": "effectgate_host_compatibility",
  "schema_version": "1.0.0",
  "client": {
    "name": "qualified-host",
    "version": "1.2.3",
    "build_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  },
  "tool_search": {
    "state": "enabled_observed",
    "configuration_digest": "sha256:0000000000000000000000000000000000000000000000000000000000000000"
  },
  "evidence_state": "pass",
  "observed_at": "2026-07-27T00:00:00.000Z",
  "expires_at": "2026-08-27T00:00:00.000Z"
}
```

Replace the placeholder digests and dates with captured qualification
evidence; never mark an assumed capability as `pass`. EG-014B retains one
sanitized real-host result for Claude Code 2.1.220 under `evidence/`. It proves
that this exact build used Tool Search to discover and call the EffectGate
fixture once. The evidence is build-bound and expires; it is not a general
claim about other Claude Code versions.

The strict manifest records an exact client name, version and SHA-256 build
digest; Tool Search state and configuration digest; evidence state; observation
time; and expiry. Native deferral metadata is added only when the manifest is
an unexpired `pass`, Tool Search was observed enabled, and initialization
supplies matching client identity plus
`_meta["dev.effectgate/clientBuildDigest"]`. Otherwise typed tools remain
available without deferral metadata and the safe reason is returned in the
initialize result. The generic identity contract still requires an explicit
client build digest; current Claude Code does not send EffectGate's private
build-digest field, so automatic exact-build admission remains separate work.

Run the deterministic `BENCH-SMALL-005` fixture adapter with:

```powershell
npm run benchmark:fixture -- --output .\benchmark.jsonl --ledger-directory .\benchmark-ledgers --repetitions 1
npm run benchmark:report -- --input .\benchmark.jsonl --output .\benchmark-report.json
npm run benchmark:recommend -- --evidence .\benchmark.jsonl --output .\exposure-recommendation.json
```

It executes the direct native fixture (P0), typed EffectGate proxy (P1),
compact mux (P2), and eager direct fixture (P3) as real child processes. The
output contains raw per-run latency, success, call count, and byte-proxy tool
schema/result measurements. P1 and P2 create joined token ledgers. No total
host-session token value or savings claim is produced. Each raw run also states
whether native deferral was qualified, unavailable, mismatched, or not
applicable.

Benchmark adapters can import `runPairedBenchmark()` from
`src/benchmark/paired-harness.mjs`. One call runs P0, P1, P2, and P3 for every
repetition in a seeded deterministic order. The callback receives stable
`pairId`, `runId`, `profile`, and `ledgerProfile` values; pass the latter two
to a candidate proxy so its token ledger can be joined to the raw run event:

```text
node effectgate.mjs mcp serve --token-ledger tokens.jsonl --run-id RUN_ID --profile LEDGER_PROFILE
```

The harness requires SHA-256 digests for common backend bytes, prompt, and
success rubric. It creates its JSONL evidence file exclusively, records every
completed or failed profile run, and never persists callback error messages.
The report validates the complete evidence matrix, retains failures, keeps
token counters separated by measurement basis, and emits median, p95, and
deterministic percentile-bootstrap 95% intervals. Fewer than 30 repetitions
are explicitly marked non-qualifying. It does not launch a model or claim
token savings; real host adapters remain separate qualification work.

The recommender validates the same raw evidence and emits the
[`exposure-recommendation` contract](../contracts/exposure-recommendation.schema.json).
It requires at least 30 repetitions, failure-free candidates, conservative
success/fetch/latency bounds, comparable measured total-input-token counts,
and exact native-deferral compatibility evidence. Its output is review-only:
it cannot change configuration or policy, never auto-applies a profile, and
never recommends direct bypass. Fixture evidence has no host-session token
count, so it intentionally produces `hold`.

The fixture exposes:

| Tool | Purpose |
|---|---|
| `fixture__echo` | Typed small-result pass-through |
| `fixture__echo_again` | Catalog pagination |
| `fixture__large_log` | Deterministic multibyte log, JSONL, CSV, or Markdown data and synthetic redaction sentinels |
| `effectgate_fetch` | Local continuation using an authenticated opaque cursor |
| `effectgate_search` | Bounded literal context search over a retained artifact |
| `effectgate_project` | Bounded JSON/JSONL, CSV/TSV, or Markdown projection |

Pin the compatibility surface at process startup with:

```text
node /absolute/path/to/EffectGate/poc/src/proxy/effectgate.mjs mcp serve --profile compact_mux
```

Compact mode publishes exactly `effectgate_search`, `effectgate_describe`,
`effectgate_call`, and `effectgate_fetch`. Catalog pagination admits only the
same safe read-only fixture tools as typed mode. Search returns bounded
metadata and an admission reference, describe returns that reference's exact
schema, call accepts its generic argument object, and fetch reuses the
authenticated Context View cursor. Direct typed names are rejected.

Try `fixture__large_log` with `{"lines": 200}`. If the returned Context View
reports `retrieval.more_available: true`, pass its cursor to
`effectgate_fetch`. Without redaction matches, concatenating each cited page
reconstructs the original log exactly. Add `"includeSecrets": true` to verify
that documented synthetic sentinels are removed from every emitted page.

Eligible untyped results with multiple content items or structured data are
serialized once as JSON when they exceed the 64 KiB result ceiling.
If retention cannot fit the 1 MiB artifact limit, EffectGate returns a bounded
`EG-CAS-001` error without reflecting source content.

Unsupported media and deterministic opacity matches are retained but withheld.
Their Context View has empty content, `status: "unavailable"`, a failed budget,
and no retrieval operations. The detector is conservative: it does not claim
that data is encrypted or secret, and it never generates a summary. Typed
results that match redaction or opacity rules return a bounded error rather
than breaking their advertised `outputSchema`.

All token measurements use the shared counter interface. Context Views retain
their deterministic byte-proxy behavior, while exact tokenizer callbacks,
calibrated estimates, and host-reported values remain explicitly separated by
basis. The preview does not bundle a tokenizer or infer total host context.
Text, search, projection, and unavailable results share one hard budget
controller. First views and fetched pages have separate byte/token ceilings;
requested search or projection limits can lower, but never raise, them.
Serialized tool catalogs and results also share a process-local cumulative
guard. Replayed results count again and rejected output is not charged. This
does not measure prompts, assistant output, JSON-RPC errors, or host context.
The optional JSONL ledger stores only counts, bytes, counter provenance,
digests, fixed safe categories, timestamps, and generated identifiers. It
rejects malformed, truncated, inconsistent, or cross-session files and never
stores the measured catalog or result content.

Use `effectgate_search` with the view's `artifact_id` and a literal `query`.
Optional `context_lines` is `0..5`; `max_tokens` is `64..1024`. Repeated
matches return an opaque cursor consumed by `effectgate_fetch`. A window
clipped by the byte budget is explicitly labeled `partial_view`.

Request JSONL fixture data with
`{"lines": 200, "format": "jsonl"}`. Use `effectgate_project` with the
returned `artifact_id`, `format: "jsonl"`, optional RFC 6901 `fields`, a
scalar-equality `filter`, `offset`, `limit`, and `max_tokens`. Projection
returns JSONL plus `record_citations`; continuation uses `effectgate_fetch`.
Malformed JSONL lines become cited diagnostics. Malformed JSON falls back to a
bounded redacted text view without repair.

For tables, request `{"lines": 200, "format": "csv"}`, then project with
`format: "csv"`, optional header `columns`, optional string-equality
`filter.column`, and the same slice and token controls. TSV uses
`format: "tsv"` for projection. Quoted fields, escaped quotes, and embedded
newlines are supported. Malformed tables fail closed.

For Markdown, request `{"lines": 200, "format": "markdown"}`. Project without
`heading` for a cited ATX heading index, or provide an exact, case-sensitive
heading title for that bounded section. Headings inside fenced code blocks are
ignored.

## Source layout

Runtime modules live under `src/`, grouped by responsibility:

```text
src/
├── benchmark/  # deterministic paired-run orchestration and raw evidence
├── budget/     # token counters, calibration, and result guards
├── context/    # Context Views and cursor state
├── projection/ # JSON, CSV/TSV, and Markdown projection
├── proxy/      # MCP entry point and fixture backend
└── storage/    # filesystem CAS
test/           # dependency-free integration and boundary checks
```

## Bounds

| Resource | Limit |
|---|---:|
| JSON-RPC frame | 1 MiB |
| Serialized tool-result value | 64 KiB |
| Local model-visible tool output | 262,144 byte-proxy tokens per process session |
| Optional token ledger | 1,000,000 entries / 64 MiB / one process writer |
| Host compatibility evidence | 16 KiB / strict JSON / exact client and build match / explicit expiry |
| Paired benchmark | 1,000 repetitions / four fixed profiles / one exclusive evidence file |
| Context View source content | 4,096 bytes per first view / fetched page |
| Search query | 64 Unicode characters / 256 UTF-8 bytes |
| Search context | 0–5 lines / 64–1,024 byte-proxy tokens |
| Projection fields | 16 unique JSON Pointers / 256 characters each |
| Projection columns | 16 unique headers / 256 characters each |
| Projection slice | Offset ≤1,048,576 / limit ≤1,000 |
| Projection page | 100 logical items / 64–1,024 byte-proxy tokens |
| Tabular record shape | 256 columns / 64 KiB field / 256 KiB record |
| CAS write chunk | 64 KiB |
| Stored artifact | 1 MiB |
| Logical artifact store | 4 MiB / 16 artifacts |
| Privacy partition key | 128 characters / 512 UTF-8 bytes; stored as SHA-256 path |
| Detected redaction spans | 4,096 per artifact; excess fails closed |
| Opacity screening | Private-key markers, integer-only encoded blocks, 1,024-byte windows, and 128-byte token runs over the capped artifact |
| Cursor token | 2 KiB maximum / HMAC-SHA256 authenticated |
| Cursor states | 64; live continuations are pinned |
| Cursor lifetime | 10 minutes; recent same-session retries are cached |
| Forwarded backend requests | 64 pending / 10 seconds each |

The filesystem objects are atomically finalized and verified before every
page read. Identical content reuses storage only within the same hashed privacy
partition. `ContextStore.invalidate()` removes that partition's object and
revokes cached and live cursors. Session metadata remains volatile and
process-local, and backend results still arrive as complete strings. The
preview has no durable index,
end-to-end streaming adapter, comprehensive secret/PII detection, regex/ranked
search, JSONPath or richer predicates, full CommonMark structure, SQLite
ledger/multi-writer recovery, real model/host benchmark adapter, externally
qualified compact-mux comparison, approval flow, fuzz qualification, or
production support claim.
