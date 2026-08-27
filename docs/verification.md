# Verification evidence

Run the dependency-free suite from a checkout:

```powershell
npm --prefix poc test
```

The list below is what those tests actually assert. It is the inventory a
reviewer should work through; see [`docs/review/v1.0.0.md`](review/v1.0.0.md)
for the independent-review handoff.

## What the suite verifies


- fixture initialization, discovery, pagination, and typed calls;
- advertised contract preservation and public-name transformation;
- first-page admission after a second catalog page is loaded;
- 4,096 Unicode code points at the fixture input limit;
- unchanged pass-through for small text results;
- v1 Context View fields, exact byte citations, and distinct hard first-view
  and fetched-page limits;
- honest byte-proxy token ceilings plus explicit omission diagnostics;
- exact, estimated, byte-proxy, and host-reported counter contracts plus
  deterministic estimate calibration;
- atomic cumulative output admission, replay accounting, session isolation,
  configurable exhaustion, and an explicit non-claim about host context;
- persistent raw-result/output provenance, byte-proxy recomputation,
  Context View identity binding, corruption denial, and secret containment;
- deterministic P0–P3 paired order and run identity, complete profile coverage,
  retained/sanitized runner failures, and evidence no-overwrite protection;
- warm small-read task timing plus fail-closed repetition, success-delta,
  matching-machine, and absolute long-lived median/p95 qualification;
- a manual, exact-Node Tier-1 performance matrix that retains complete paired,
  statistical, profiler, and failed-gate evidence before enforcing the verdict;
- fail-closed exposure recommendations with measured quality gates, explicit
  review requirements, no policy mutation, and no direct-bypass suggestion;
- offline target-corpus admission that rejects incomplete profile matrices,
  inconsistent environments, token proxies, and missing native-deferral proof;
- phase/Capsule-bound protected-intent preparation, exact approval admission,
  idempotent dispatch, lost-response reconciliation, verified Effect/Phase
  Receipts, startup recovery without duplicate dispatch, and stale-state
  denial;
- user-local exact-argument approval review with no raw argument persistence,
  explicit approval/denial, hidden single-use lease consumption,
  argument-drift denial, verification-only targeted reconciliation, and
  explicit manual-resolution receipts that preserve uncertain certainty;
- digest-pinned reviewed stdio effect initialization, exact tool-contract
  validation, concurrent duplicate suppression, intent-drift rejection,
  timeout/crash recovery, and backend restart persistence;
- real direct, typed-proxy, and eager fixture process runs with exact-payload
  oracles, byte-proxy schema/result events, and joined P1 token provenance;
- exact compact search/describe/call/fetch contracts, paged admission,
  direct-name denial, Context View continuation, and real P2 ledger evidence;
- strict host-evidence parsing, exact client/build matching, expiry and weak-state
  denial, qualified metadata, and raw-event compatibility attribution;
- byte-for-byte reconstruction across multibyte UTF-8 page boundaries;
- assignment, bearer-token, and prefixed-token sentinel removal across every
  first/fetched page;
- fail-closed typed-result handling for all three synthetic secret classes;
- cross-page secret masking and fail-closed redaction-span limits;
- unique, repeated, absent, Unicode, and hard-budget literal searches;
- search-cursor replay plus indistinguishable invented/cross-session artifact
  denials;
- secret-query containment across search content, metadata, and diagnostics;
- JSON/JSONL pointer selection, equality filtering, slicing, cursor replay, and
  per-record citation mapping;
- quoted JSON secret redaction, malformed JSON fallback, cited malformed JSONL
  diagnostics, requested-budget continuation, and oversized-record omission;
- CSV quoting, escaped quotes, embedded newlines, TSV parsing, column
  selection/filtering, structural sensitive-column redaction, and malformed
  table rejection;
- Markdown ATX heading indexes, exact section extraction, fenced-code
  exclusion, secret redaction, paging, and source citation mapping;
- indistinguishable invented and cross-session projection denials;
- same-session cursor retry with a byte-identical cached page;
- authenticated cursor claims, payload/MAC tamper denial, raw-query
  containment, expiry, and cross-store rejection with one public error;
- pinning of artifacts that still have a live continuation;
- atomic filesystem finalization, interrupted `.part` recovery, same-partition
  cross-instance deduplication, and cross-partition path isolation;
- artifact invalidation with cached-replay and live-continuation revocation;
- full-hash read verification, corruption quarantine, and physical deletion
  only after cursor pins are released;
- whole-result output caps for errors, structured data, and typed results;
- deterministic JSON retention of oversized untyped envelopes and bounded retention
  failure without source-data reflection;
- deterministic opaque-content withholding across initial, search, and
  projection paths, including exact detector boundaries, private-key armor,
  wrapped base64/hex data, final-tail data, and configured artifact ceilings;
- oversized catalog-page rejection before tool admission;
- malformed and oversized frame rejection with parser recovery;
- seeded JSONL/MCP boundary mutation evidence with an exact replay seed;
- seeded protected-effect binding, policy, and argument mutation evidence;
- real-process frame recovery, pending-request saturation, and backend-crash
  cleanup without secret reflection;
- zero third-party runtime dependencies and exact reviewed Action commits;
- invalid request-ID sanitization without reflecting hidden values;
- direct and invented backend-name rejection;
- fixture admission plus read-only/open-world deny cases;
- arbitrary-backend command refusal.

