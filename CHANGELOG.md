# Changelog

All notable changes to EffectGate are documented here.

## 1.0.1 — 2026-09-02

### Fixed

- Labels every admitted backend tool as EffectGate-routed so agents do not
  mistake the required Context View bootstrap call for a native bypass.
- Explains that eligible large backend results return the session-local
  `artifact_id` used by EffectGate search, projection, and fetch.
- Adds an installed-package regression path covering bootstrap, bounded Context
  View creation, artifact search, and cited evidence retrieval.

### Documentation

- Clarifies that artifact IDs must come from a routed backend call and must
  never be guessed, derived, or discovered through MCP Resources.

## 1.0.0 — 2026-08-02

EffectGate 1.0 is a dependency-free Node.js runtime that controls what MCP tool
evidence reaches a model and which declared effects may execute. A build is a
stable release only when its exact source commit has the required Tier-1
evidence and five-role Ed25519 sign-off.

### Context control

- Retains large and opaque tool results in a local content-addressed store.
- Accepts digest-verified large backend results through bounded JSON-RPC chunks
  while preserving the 1 MiB per-frame limit.
- Emits bounded, cited text pages, literal search windows, and structured
  JSON/JSONL, CSV/TSV, and Markdown projections through signed opaque cursors.
- Applies deterministic high-signal credential redaction, conservative opacity
  screening, output ceilings, replay protection, and privacy partitions.
- Supports typed tools, a compact MCP multiplexer, and evidence-qualified
  native Tool Search deferral.

### Effect control

- Compiles skill sources into canonical passports, phase graphs, instruction
  capsules, policies, effect intents, approval leases, and verification plans.
- Admits only declared phase- and capsule-bound effects with exact argument,
  resource-scope, disclosure, policy, and idempotency bindings.
- Persists append-only operation state in SQLite and recovers interrupted
  dispatch without blind retries.
- Verifies, reconciles, or explicitly records uncertain outcomes and issues
  hash-chained Ed25519 effect receipts.
- Includes reviewed in-memory and digest-pinned stdio effect adapters.

### Operations and release qualification

- Provides `init`, `doctor`, `status`, `receipt`, `approve`, `resolve`, `backup`,
  `restore`, `rollback`, `purge`, and non-destructive `uninstall` planning.
- Supports layered configuration, environment-only secret references, owned
  state directories, verified backups, and confirmation-bound recovery.
- Produces reproducible npm tarballs, CycloneDX SBOMs, source-bound provenance,
  checksums, canonical release evidence, signed role approvals, and final
  sign-off evidence.
- Defines manual-only qualification for Linux x64/arm64, Windows x64, and macOS
  x64/arm64. The runtime itself is not tied to Ubuntu.

### Compatibility and limits

- Requires Node.js 24 or newer and has no runtime package dependencies.
- Uses MCP `2025-11-25` over local stdio; there is no network listener.
- Retains the `effectgate-preview` npm and MCP identifier so existing installs,
  state, and integrations upgrade without a package rename.
- Admits only bundled or independently reviewed digest-pinned adapters.
- Redaction and opacity detection are conservative heuristics, not comprehensive
  secret or PII protection; EffectGate is not an operating-system sandbox.
- Hardware-backed key custody, encrypted key integration, streamable HTTP, and
  broader backend adapters remain post-1.0 work.
