# Security policy

## Project status

EffectGate is currently a fixture-only Phase 1 preview. It includes a bounded,
filesystem-backed Context View path with deterministic high-signal credential
redaction and volatile session metadata. It is not production-ready and must
not be used to protect real tool effects, secrets, or untrusted external
backends.

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
- access to an arbitrary backend or protected/write operation;
- leakage of raw backend errors, process data, credentials, or hidden names;
- protocol confusion, request-correlation failure, or namespace collision;
- skipped, duplicated, oversized, or uncited Context View bytes;
- acceptance of interrupted, missing, truncated, or hash-mismatched CAS data;
- cross-session cursor use, expiry bypass, modification, or existence leaks;
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
- only the bundled deterministic fixture is launched;
- MCP clients may send malformed or adversarial protocol input;
- the fixture may generate documented synthetic secret sentinels but contains
  no real credentials or personal data;
- one proxy process represents one cursor session;
- tool annotations are admission inputs, not proof that an unknown backend is
  safe.

## Known preview limitations

- The fixture child runs with the current user's operating-system permissions;
  EffectGate is not an OS sandbox.
- There is no authentication, encryption, tenant isolation, persistent audit
  journal, approval flow, or reconciliation.
- Redaction is a versioned preview heuristic limited to assignment values,
  bearer tokens, and selected token prefixes. It is not comprehensive
  secret/PII detection or protection. More than 4,096 detected spans fails
  closed.
- Backend results still arrive at the proxy as complete strings; ingestion is
  not yet end-to-end bounded-memory streaming.
- Finalized raw objects use a process-owned temporary filesystem CAS. Session
  metadata is memory-only, abrupt termination may leave an undiscovered
  temporary root, and there is no secure-erasure guarantee.
- File data is synced before same-volume rename, but directory durability,
  shared-writer locking, durable metadata, and crash qualification are not yet
  production claims. Network filesystems are unsupported.
- Artifact identifiers expose a SHA-256 content digest. Do not use this preview
  with secret-bearing or attacker-controlled real-world results.
- Cursor binding is achieved by random server-side, process-local state. There
  is no principal, client identity, or durable policy-generation binding yet.
- The 4 KiB Context View budget covers source content; the surrounding MCP/JSON
  tool-result value is capped at 64 KiB and the complete frame at 1 MiB.
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
