# Security policy

## Project status

EffectGate is currently a fixture-only Phase 1 preview. It includes a bounded,
filesystem-backed Context View path with deterministic high-signal credential
redaction, conservative opaque-content withholding, and volatile session
metadata. A separate configured profile exercises protected effects against a
reviewed in-memory fixture with a persistent local journal. It is not
production-ready and must not be used to protect real tool effects, secrets,
or untrusted external backends.

## Supported versions

| Version | Security support |
|---|---|
| Latest commit on `main` | Confirmed issues addressed on a best-effort basis |
| Older commits, forks, and modified builds | Not supported |
| Stable releases | None published |

## Report a vulnerability privately

Do not disclose vulnerability details in an issue, discussion, pull request, or
other public channel.

1. If the repository Security tab offers **Report a vulnerability**, use that
   private reporting form.
2. Otherwise, open an issue titled `Security contact request` containing no
   technical details. The maintainer will arrange a private channel.
3. Include the affected commit, Node.js/OS versions, demonstrated impact,
   minimal reproduction using the bundled fixture, and any known mitigation.
4. Remove credentials, personal data, and unrelated secrets from all evidence.

If encrypted transfer is needed, request a suitable channel before sending
sensitive material.

## Response targets

These are best-effort targets, not contractual service-level guarantees:

| Milestone | Target |
|---|---|
| Acknowledge a complete report | 3 business days |
| Initial severity assessment | 7 business days |
| Progress update while unresolved | Every 14 days |
| Critical fix or mitigation | Within 30 days when feasible |
| High-severity fix or mitigation | Within 60 days when feasible |

Lower-severity findings may be scheduled for a later development phase.

## In scope

Reports are especially useful when they demonstrate:

- a bypass of frame, pending-request, timeout, or backpressure limits;
- invocation of a tool outside the admitted public catalog;
- access to an arbitrary backend or a protected/write operation outside the
  exact configured fixture binding;
- leakage of raw backend errors, process data, credentials, or hidden names;
- protocol confusion, request-correlation failure, or namespace collision;
- skipped, duplicated, oversized, or uncited Context View bytes;
- acceptance of interrupted, missing, truncated, or hash-mismatched CAS data;
- cross-session cursor use, expiry bypass, modification, or existence leaks;
- cross-session artifact search or search-result existence oracles;
- cross-session artifact projection or projection-result existence oracles;
- uncited, invented, skipped, duplicated, or secret-bearing projected records;
- retrieval of content classified as unsupported or opaque through any
  model-visible first, fetch, search, or projection path;
- bypass of artifact, store, or active-cursor quotas;
- escape from the intended child-process or environment boundary;
- a reproducible resource-exhaustion path beyond documented limitations.

Issues solely in Node.js, an MCP client, or the operating system should be
reported upstream unless EffectGate makes the issue exploitable.

Unimplemented design proposals and hypothetical external-backend behavior are
out of scope until those features exist.

## Current trust boundary

The current preview assumes:

- the operating-system user, local Node.js runtime, and checkout are trusted;
- only bundled deterministic fixtures and the exact built-in memory-patch
  driver are available;
- MCP clients may send malformed or adversarial protocol input;
- the fixture may generate documented synthetic secret sentinels but contains
  no real credentials or personal data;
- one proxy process represents one cursor session;
- tool annotations are admission inputs, not proof that an unknown backend is
  safe.

## Known preview limitations

- The fixture child runs with the current user's operating-system permissions;
  EffectGate is not an OS sandbox.
- There is no authentication, encryption, tenant isolation, or operator
  approval UI. The configured fixture has a persistent operation journal and
  reconciliation evidence, but its in-memory backend state does not survive a
  restart.
- Redaction is a versioned preview heuristic limited to assignment values,
  bearer tokens, and selected token prefixes. It is not comprehensive
  secret/PII detection or protection. More than 4,096 detected spans fails
  closed.
- Opacity screening is a deterministic, integer-only preview heuristic over a
  maximum 1 MiB artifact. It may withhold generated, minified, or encoded text
  that is not secret. It does not identify encryption, replace redaction, or
  prove that unflagged content is safe. It checks selected private-key markers,
  long token runs, wrapped base64-like/hexadecimal blocks, and bounded
  byte-distribution windows. Flagged artifacts expose metadata only, with no
  model-visible fetch, search, or projection path.
- Typed results are screened too. If redaction or opacity handling would violate
  an advertised `outputSchema`, EffectGate returns a bounded safe error rather
  than source content.
- Backend results still arrive at the proxy as complete strings; ingestion is
  not yet end-to-end bounded-memory streaming.
- Finalized raw objects use a process-owned temporary filesystem CAS. Session
  metadata is memory-only, abrupt termination may leave an undiscovered
  temporary root, and there is no secure-erasure guarantee.
- CAS object, temporary, and quarantine paths are separated by a SHA-256 hash
  of the configured privacy partition; the raw partition label is not used as
  a path. The default Context Store partition is session-specific. Explicitly
  sharing a partition between processes remains a trusted single-writer
  preview configuration without reference-counted deletion.
- File data is synced before same-volume rename, but directory durability,
  shared-writer locking, durable metadata, and crash qualification are not yet
  production claims. Network filesystems are unsupported.
- The optional token ledger is a flushed, append-only JSONL file for one proxy
  process/session. It stores digests, counts, generated identifiers, fixed safe
  categories, and timestamps but no measured content. It rejects a malformed,
  truncated, inconsistent, or foreign-session file; it has no shared-writer
  locking, SQLite transaction recovery, encryption, or secure-erasure claim.
- The paired benchmark harness creates new JSONL evidence exclusively and stores
  common-input digests rather than prompt, backend, or rubric content. Runner
  failure messages are discarded. The caller and its `runProfile` callback are
  trusted; the harness is not a sandbox for external model or host adapters.
  The bundled adapter launches only the fixture and preview proxy and measures
  tool schema/result byte proxies—not host total session usage.
- Compact mode admits only tools carrying all four safe-read annotations and
  denies direct typed-name calls. Its generic call envelope does not validate
  arguments against the described JSON Schema inside the proxy; the bundled
  fixture performs backend validation. Compact quality and arbitrary-backend
  behavior are not production claims.
- Native-deferral metadata requires a local evidence file no larger than 16 KiB,
  an unexpired `pass` state, observed-enabled Tool Search, and exact client
  name/version/build digest supplied at initialization. The file path and raw
  configuration are not model-visible. This preview assertion is not
  authenticated client identity. EG-014B separately qualifies Tool Search
  behavior for the exact Claude Code 2.1.220 binary recorded in
  `poc/evidence/`; it does not extend trust to other builds.
- Artifact identifiers expose a SHA-256 content digest. Do not use this preview
  with secret-bearing or attacker-controlled real-world results.
- Cursor envelopes use HMAC-SHA256 and bind artifact, source view, next
  position, operation digest, budget, binding digests, expiry, and nonce to
  process-local replay state. The preview uses a local-user label, random
  process/client and session identifiers, and a fixed read-only policy version;
  it does not authenticate an OS principal or host client and has no durable
  policy-generation binding.
- Search is a bounded, case-sensitive literal scan over at most a 1 MiB
  artifact. It has no regex, semantic ranking, persistent index, or untrusted
  query logging, and it decodes the complete artifact for each search page.
- JSON/JSONL projection reparses at most a 1 MiB artifact per page using the
  built-in JSON parser. It supports JSON Pointer fields and scalar equality
  only—no JSONPath, expressions, code execution, comparison, or membership.
- Malformed JSON falls back to bounded redacted text without repair. Malformed
  JSONL lines and records larger than the projection budget become cited
  diagnostics rather than model-visible raw data.
- CSV/TSV projection reparses at most a 1 MiB artifact per page with a strict
  dependency-free parser. It limits columns, fields, and records; treats the
  first row as a unique non-empty header; and structurally redacts common
  credential columns. It does not infer dialects or types, evaluate formulas,
  or support comparison and membership predicates. Malformed tables fail
  closed rather than falling back to text.
- Markdown projection recognizes ATX headings only, ignores headings inside
  fenced code blocks, and selects sections by exact case-sensitive title. It
  does not render HTML or implement full CommonMark or Setext headings.
- The 4 KiB Context View budget covers source content; the surrounding MCP/JSON
  tool-result value is capped at 64 KiB and the complete frame at 1 MiB.
- Oversized untyped tool-result envelopes are retained as serialized JSON when
  possible. Retention or capacity failure returns a bounded `EG-CAS-001` error
  without reflecting the rejected source.
- Artifacts with an unfetched continuation are pinned until the cursor expires;
  new ingestion fails closed when only pinned artifacts occupy the quota.
- Frame and pending-request limits reduce resource risk but are not complete
  denial-of-service protection.
- The proxy validates the tool envelope and admission map, but the bundled
  fixture—not the proxy—validates call arguments against its advertised shape.
- Compromise of the local user account, malicious replacement of repository
  files, and physical host access are outside this threat model.

Reports that only restate these limitations without additional impact may be
closed as expected behavior.

## Coordinated disclosure

Please allow time to validate and remediate a confirmed issue before public
disclosure. The preferred window is up to 90 days from acknowledgement, or
until a fix is available, whichever comes first, unless another timeline is
agreed.

Good-faith research should use the bundled fixture, minimize access and
disruption, stop if unintended data is encountered, and avoid persistence,
exfiltration, or testing against third-party systems.

After remediation, the maintainer may publish an advisory describing impact,
affected commits, and the fix. Reporter credit preferences will be followed
where legally and operationally possible.
