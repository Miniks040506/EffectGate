# EffectGate 1.0

This dependency-free Node.js runtime provides two controlled paths:

```text
small typed result  -> unchanged MCP result
large text result   -> temporary filesystem CAS -> redacted view
other large result  -> serialized JSON in CAS -> bounded view
opaque/unknown data -> retained in CAS -> metadata-only unavailable view
retained artifact   -> fetch / literal search / JSON or JSONL projection
                    -> CSV or TSV projection / Markdown heading extraction
```

The default remains fixture-only. A reviewed configuration may launch one
exact digest-pinned third-party stdio backend and expose only its immutable
safe-read catalog. Unreviewed commands, third-party writes, real
secret-bearing data, and production use remain disabled.

The configured profiles reopen their SQLite journals on startup, reconcile an
interrupted dispatch without invoking it again, and publish no effect tool
after their one-phase transaction completes. The optional
`effectgate.fixture.stdio-patch.v1` driver additionally launches only the
digest-pinned bundled stdio fixture and persists its idempotency records across
child-process restarts.

## Run

```powershell
cd poc
npm test
npm start
```

Install the checked-out runtime as a global `effectgate` command:

```powershell
npm install --global .
effectgate --version
effectgate mcp serve
```

The packed artifact is dependency-free and contains only runtime source, this
guide, package metadata, and the Apache-2.0 license. The automated package
qualification packs it offline, installs that exact tarball into a clean
temporary consumer, checks the generated command shim, and completes an MCP
initialize exchange through the installed CLI.
Re-running the install command leaves external configuration and state
untouched. The package has no install or uninstall lifecycle scripts.

Print the non-destructive uninstall plan before removing the CLI:

```powershell
effectgate uninstall --config C:\path\to\effectgate.json
npm uninstall --global effectgate-preview
```

The plan lists every preserved path and an optional exact purge command.
`effectgate purge --config FILE` is non-mutating until rerun with its printed
SHA-256 confirmation and `--yes`; it accepts only an init-created state
ownership marker and never deletes configuration or skill sources. Run an
optional purge before uninstalling the CLI.

Point an MCP stdio client at:

```text
node /absolute/path/to/EffectGate/poc/src/proxy/effectgate.mjs mcp serve
```

For an independently reviewed read-only stdio backend, pin its executable,
operator-reviewed source files, argv, working directory, server identity, and
exact single-page catalog as documented in the root README, then run:

```text
node /absolute/path/to/EffectGate/poc/src/proxy/effectgate.mjs mcp serve --config /absolute/path/to/reviewed-backend.json
```

Serve the reviewed verified-effect fixture described in the root README:

```text
node /absolute/path/to/EffectGate/poc/src/proxy/effectgate.mjs mcp skill serve --config /absolute/path/to/effectgate.json
```

Package qualification is defined in
`.github/workflows/tier1-package.yml`. It is manual-only and runs the full
suite plus the pinned `0.17.0` → `1.0.0` → `0.17.0` → `1.0.0` package
rehearsal on Linux x64, Linux arm64, Windows x64, and macOS x64. The concrete
Linux runner images use Ubuntu 24.04, but the Node package has no Ubuntu-only
runtime dependency. Each cell emits a machine-readable evidence line and
requires external state to remain unchanged.

Create and inspect that configuration through the non-interactive operator
commands:

```text
node src/proxy/effectgate.mjs init --config /path/effectgate.json --state /path/state --skill-root /path/skill --target docs/guide.md --transaction reviewed-transaction --dry-run --json
node src/proxy/effectgate.mjs doctor --config /path/effectgate.json --json
node src/proxy/effectgate.mjs status --config /path/effectgate.json --json
node src/proxy/effectgate.mjs receipt --config /path/effectgate.json --id RECEIPT_ID --json
node src/proxy/effectgate.mjs approve --config /path/effectgate.json --operation OPERATION_ID --json
node src/proxy/effectgate.mjs resolve --config /path/effectgate.json --operation OPERATION_ID --json
node src/proxy/effectgate.mjs backup --config /path/effectgate.json --output /path/new-backup --json
node src/proxy/effectgate.mjs restore --backup /path/new-backup --config /path/restored.json --state /path/new-state --json
node src/proxy/effectgate.mjs rollback --backup /path/new-backup --config /path/rollback.json --state /path/rollback-state --json
```

Backup destinations must not exist and must be outside the state directory.
EffectGate locks the known SQLite set at one cut, uses SQLite online backup,
normalizes isolated copies to sidecar-free `DELETE` journaling, verifies every
copy, then writes a normalized secret-reference-only
configuration, an explicit empty durable-CAS manifest, and final manifest plus
checksum files. A destination lacking both final manifest files is incomplete.

Restore destinations must also be new and outside the backup and skill roots.
The exact-version manifest, checksum, canonical metadata, every streamed file
digest, and every SQLite copy are verified before publication. Restore writes
a new ownership marker and configuration, revokes copied approval leases, and
runs startup recovery so undispatched work is abandoned and dispatched work
requires reconciliation. Process-local retrieval cursors are never restored.

Rollback is confirmation-bound and accepts only the exact qualified package
version recorded by the backup. Its preview step creates nothing. After confirmation
it reuses verified fresh-path restore, preserves live state, and prints—but
does not execute—the exact npm reinstall and `doctor` commands. Review those
commands and complete operator sign-off before resuming protected effects.

Configuration files may name one parent with `"extends": "../base.json"`.
EffectGate loads at most eight layers parent-first, reports their exact
precedence through `doctor --json`, and lets child fields override parent
fields. Reviewed stdio profiles may map backend variables to environment-only
references such as
`"secret_refs": {"BACKEND_TOKEN": "env:EFFECTGATE_BACKEND_TOKEN"}`.
Missing references fail before runtime state is created; resolved values are
never persisted or printed.

Use `--apply` instead of `--dry-run` only after reviewing the generated paths.
Init never overwrites an existing configuration. Doctor's backend handshake and
all confirmation/status/receipt database access are non-mutating. The first
effect call waits for approval. While the runtime remains running, the plain
`approve` command displays exact in-memory arguments and an intent digest over
a user-only local socket/pipe. Confirm with
`approve ... --approver ID --intent DIGEST --yes`, or deny with
`approve ... --deny`; approval bearer material never leaves the runtime and raw
arguments never enter its journal. Repeat the identical MCP call after
approval. Use `resolve ... --reconcile` for one bounded verification-only
attempt that cannot redispatch the effect. For an independently investigated
uncertain outcome, use
`resolve ... --manual --receipt ID --note TEXT --yes`; only the note digest is
stored, and the receipt remains explicitly `manual_resolution`.

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

Captured real-host observations can be normalized and qualified entirely
offline:

```powershell
npm run benchmark:corpus -- --source-commit FULL_40_CHARACTER_GIT_SHA
npm run benchmark:observe -- --input .\BENCH-READ-001.observations.json --output .\BENCH-READ-001.jsonl
npm run benchmark:target -- --input .\target-corpus-manifest.json > .\target-corpus-qualification.json
```

Prepare a restart-safe Claude MCP configuration without launching Claude:

```powershell
npm run --silent benchmark:claude-capture -- dry-run --ledger-directory .\claude-ledgers --run-id RUN_ID --profile native_deferred > claude-mcp-dry-run.json
```

Use the emitted `mcp_config` for a separately authorized Claude run. Every MCP
process or host retry creates a unique ledger plus a canonical attempt manifest,
so a retry cannot collide with the prior process's session-bound ledger. After
retaining Claude's `--output-format json` event, normalize its usage offline:

```powershell
npm run --silent benchmark:claude-capture -- normalize --input .\claude-raw.json --output .\claude-capture.json --source-commit FULL_40_CHARACTER_GIT_SHA --task-id BENCH-READ-001 --profile P0_NATIVE_DEFAULT --repetition 0 --host-version 2.1.233 --observed-at 2026-08-16T08:00:00.000Z
```

Normalization never launches Claude. It binds the exact raw-event digest,
records comparable host-reported input usage, and stores only a digest and byte
length for the final model text.

`benchmark:corpus` builds the frozen `LOG_80K`, `JSON_50K`, `JSONL_25MB`, and
`CSV_100K` datasets, verifies their pinned SHA-256 digests, retains each in the
32 MiB ContextStore, and executes cited search/projection oracles with a 4 KiB
first-view ceiling. This is context-plane qualification only: the output sets
`release_gate_eligible` and `exact_corpus_mcp_stdio_qualified` to `false`
because stdio JSON-RPC frames remain independently capped at 1 MiB.

The canonical observation file contains the source commit, common environment
and prompt/rubric digests, plus exactly one P0/P1/P2/P3 metrics record for each
repetition. The target manifest binds evidence for `BENCH-READ-001`,
`BENCH-JSON-002`, `BENCH-STREAM-003`, and `BENCH-TABLE-004`. Qualification
requires 20 complete real-model repetitions per task, qualified native
deferral, no more than a two-point conservative task-success loss, at most a
10% fetch-rate bound, at least 70% first-view reduction, and at least 40%
measured total-input reduction. Only comparable `host_reported` or
`tokenizer_exact` total-input counts can satisfy the token gate; byte proxies
remain useful diagnostics but produce `fail`. These commands do not launch a
model, access a network, or spend provider credits.

For P0, `tool_result_tokens` describes the native initial result; for P1 it
describes only the bounded first view. `total_input_tokens` covers the complete
task session. Every token count's `input_digest` must bind the retained raw host
usage event or exact tokenizer input; the importer does not convert estimates
into measured values.

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
If retention cannot fit the 32 MiB artifact limit, EffectGate returns a bounded
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
basis. EffectGate does not bundle a tokenizer or infer total host context.
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
| Chunked backend tool result | 512 KiB raw chunks / 32 MiB cumulative / ordered and SHA-256 verified |
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
| Stored artifact | 32 MiB |
| Logical artifact store | 64 MiB / 16 artifacts |
| Privacy partition key | 128 characters / 512 UTF-8 bytes; stored as SHA-256 path |
| Detected redaction spans | 4,096 per artifact; excess fails closed |
| Opacity screening | Private-key markers, integer-only encoded blocks, 1,024-byte windows, and 128-byte token runs over the capped artifact |
| Cursor token | 2 KiB maximum / HMAC-SHA256 authenticated |
| Cursor states | 64; live continuations are pinned |
| Cursor lifetime | 10 minutes; recent same-session retries are cached |
| Forwarded backend requests | 64 pending / 10 seconds each |

Backends that support EffectGate's optional large-result extension emit ordered
`notifications/effectgate/result_chunk` notifications whose `data` field is
canonical base64, then finish the original request with a
`dev.effectgate/chunked-result` byte-count and SHA-256 manifest. EffectGate
reconstructs only the backend tool-result JSON, retains its content locally,
and sends the client the ordinary bounded Context View result. Missing,
reordered, oversized, non-canonical, or digest-mismatched chunks fail closed.
Backends without this extension retain the normal 1 MiB response-frame limit.

The filesystem objects are atomically finalized and verified before every
page read. Identical content reuses storage only within the same hashed privacy
partition. `ContextStore.invalidate()` removes that partition's object and
revokes cached and live cursors. Session metadata remains volatile and
process-local, and backend results still arrive as complete strings. The
runtime has no durable index,
end-to-end streaming adapter, comprehensive secret/PII detection, regex/ranked
search, JSONPath or richer predicates, full CommonMark structure, SQLite
ledger/multi-writer recovery, real model/host benchmark adapter, externally
qualified compact-mux comparison, semantic argument-diff TUI, fuzz
qualification, or production support claim.
