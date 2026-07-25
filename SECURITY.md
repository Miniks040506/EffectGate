# Security policy

## Project status

EffectGate is currently a Phase 0, fixture-only proof of concept. It is not
production-ready and must not be used to protect real tool effects, secrets, or
untrusted external backends.

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
- escape from the intended child-process or environment boundary;
- a reproducible resource-exhaustion path beyond documented limitations.

Issues solely in Node.js, an MCP client, or the operating system should be
reported upstream unless EffectGate makes the issue exploitable.

Unimplemented design proposals and hypothetical external-backend behavior are
out of scope until those features exist.

## Current trust boundary

Phase 0 assumes:

- the operating-system user, local Node.js runtime, and checkout are trusted;
- only the bundled deterministic fixture is launched;
- MCP clients may send malformed or adversarial protocol input;
- tool annotations are admission inputs, not proof that an unknown backend is
  safe.

## Known Phase 0 limitations

- The fixture child runs with the current user's operating-system permissions;
  EffectGate is not an OS sandbox.
- There is no authentication, encryption, tenant isolation, secret redaction,
  persistent audit journal, approval flow, or reconciliation.
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
