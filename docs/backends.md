# Connecting real backends

By default EffectGate proxies only its bundled deterministic fixture. This
guide covers the two reviewed bindings that go beyond it: a **read-only
third-party stdio backend**, and the **verified-effect fixture** that exercises
the approval, journal, idempotency, verification, and receipt kernel.

> [!IMPORTANT]
> Both paths require operator review of exact bytes. EffectGate deliberately
> refuses to trust whatever an unknown process reports about itself. Tool
> annotations are untrusted metadata, not proof that a backend is safe.

Run every command below from the repository root.

## Reviewed third-party read backend

Calculate SHA-256 pins for the exact executable and every operator-reviewed
source file:

```powershell
node --input-type=module -e "import { reviewedFileDigest as digest } from './poc/src/proxy/reviewed-backend-config.mjs'; console.log(digest(process.argv[1]))" "D:\path\to\backend.exe"
```

Create a layered configuration with the exact launch binding, server identity,
and reviewed single-page `tools/list` result:

```json
{
  "schema_version": "1.0.0",
  "driver": "effectgate.reviewed.stdio-read.v1",
  "source": "reviewed",
  "executable_path": "D:\\path\\to\\backend.exe",
  "executable_digest": "sha256:REPLACE_WITH_64_HEX_CHARACTERS",
  "argv": [],
  "working_directory": "D:\\path\\to\\backend-work",
  "source_files": [],
  "server_identity": {
    "name": "reviewed-backend",
    "version": "1.0.0"
  },
  "catalog": {
    "tools": [{
      "name": "lookup",
      "inputSchema": {"type": "object"},
      "annotations": {
        "readOnlyHint": true,
        "destructiveHint": false,
        "idempotentHint": true,
        "openWorldHint": false
      }
    }]
  }
}
```

Capture and review the catalog out of band; EffectGate deliberately does not
auto-seal whatever an untrusted process reports. Start the proxy with:

```text
node /absolute/path/to/EffectGate/poc/src/proxy/effectgate.mjs mcp serve --config /absolute/path/to/reviewed-backend.json
```

The binding uses exact argv with no shell, a canonical working directory, the
base environment allowlist plus optional `secret_refs`, and repeated source
digest checks. Initialization must match the pinned MCP protocol and server
identity. The catalog must match byte-for-byte after canonical JSON
normalization, must be one immutable page, and may expose only tools carrying
all four safe-read annotations. Writes, dynamic catalogs, direct backend names,
invented names, source drift, and identity drift fail closed.

## Configured verified-effect fixture

Create a reviewed skill root containing `SKILL.md` and `phases/modify.md`.
The operator CLI can pin both source digests and create the reviewed stdio
configuration without overwriting an existing file. Preview first:

```powershell
node .\poc\src\proxy\effectgate.mjs init --config D:\path\to\effectgate.json --state D:\path\to\effectgate-state --skill-root D:\path\to\skill --target docs/guide.md --transaction reviewed-transaction --dry-run --json
```

Replace `--dry-run` with `--apply` after reviewing the paths. Diagnose without
starting the MCP runtime or creating a backend database:

```powershell
node .\poc\src\proxy\effectgate.mjs doctor --config D:\path\to\effectgate.json
node .\poc\src\proxy\effectgate.mjs status --config D:\path\to\effectgate.json
node .\poc\src\proxy\effectgate.mjs receipt --config D:\path\to\effectgate.json --id RECEIPT_ID
node .\poc\src\proxy\effectgate.mjs approve --config D:\path\to\effectgate.json --operation OPERATION_ID
node .\poc\src\proxy\effectgate.mjs resolve --config D:\path\to\effectgate.json --operation OPERATION_ID
node .\poc\src\proxy\effectgate.mjs backup --config D:\path\to\effectgate.json --output D:\backups\effectgate-2026-07-31
node .\poc\src\proxy\effectgate.mjs restore --backup D:\backups\effectgate-2026-07-31 --config D:\restored\effectgate.json --state D:\restored\state
node .\poc\src\proxy\effectgate.mjs rollback --backup D:\backups\effectgate-2026-07-31 --config D:\rollback\effectgate.json --state D:\rollback\state
```

Add `--json` to any inspection command for stable machine-readable output.
`doctor` opens existing databases read-only, performs an exact no-state stdio
handshake, and verifies that operator-generated configurations use local CLI
approval. `status` and `receipt` validate persisted chains and never expose raw
effect arguments. Approval inspection deliberately shows exact arguments only
over the user-local operator channel while the MCP runtime is running.

`backup` requires a new destination under an existing parent. It rejects
overlapping destinations and unknown databases, holds one attached SQLite
write barrier, copies every known database through SQLite's online-backup API,
normalizes each isolated copy to sidecar-free `DELETE` journaling, and runs
integrity checks before publishing `manifest.json` and
`manifest.sha256`. The artifact contains normalized configuration with secret
references only and an explicit empty CAS manifest because the current
configured effect runtime has no durable CAS. Existing backup paths are never
overwritten; a directory without both final manifest files is incomplete.

`restore` requires new configuration and state paths under existing parents.
It accepts only an exact-version, canonical backup with a valid checksum,
known files, matching streamed digests, and healthy SQLite copies. Before
publishing the new ownership marker and configuration, it rechecks the copied
databases, revokes unconsumed approval leases, abandons undispatched work, and
makes any operation copied during dispatch `uncertain` for reconciliation.
Retrieval cursors are process-local and therefore are not restored. Source
configuration, state, skill files, and the backup remain unchanged.

`rollback` first prints a non-mutating plan bound to the verified manifest,
fresh destinations, and exact EffectGate package version. Rerun it with the
printed `--confirm DIGEST --yes` arguments to restore the paired state. It
preserves live state and never runs npm automatically; instead, it returns the
exact package reinstall and `doctor` postcheck commands. Operator sign-off is
required before the restored configuration is used for protected effects.
Backups from unqualified EffectGate versions fail closed.

For manual configuration, calculate the skill's pinned digest:

```powershell
node --input-type=module -e "import { importSkillSource } from './poc/src/skill/source-import.mjs'; console.log(importSkillSource({root: process.argv[1], paths: ['SKILL.md', 'phases/modify.md']}).source_digest)" "D:\path\to\skill"
```

Then create a configuration containing only the built-in fixture driver:

```json
{
  "schema_version": "1.0.0",
  "driver": "effectgate.fixture.memory-patch.v1",
  "state_directory": "D:\\path\\to\\effectgate-state",
  "skill_root": "D:\\path\\to\\skill",
  "skill_source_digest": "sha256:REPLACE_WITH_64_HEX_CHARACTERS",
  "transaction_id": "reviewed-transaction",
  "principal_id": "local-operator",
  "client_id": "local-mcp-client",
  "target_path": "docs/guide.md",
  "resource_scope": "repo:fixture/path:docs/guide.md"
}
```

To exercise the reviewed child-process adapter, calculate the bundled adapter
digest:

```powershell
node --input-type=module -e "import { stdioEffectAdapterSourceDigest as digest } from './poc/src/skill/stdio-effect-adapter.mjs'; console.log(digest())"
```

Change `driver` to `effectgate.fixture.stdio-patch.v1` and add:

```json
"backend_source_digest": "sha256:REPLACE_WITH_THE_REPORTED_DIGEST",
"approval_mode": "cli"
```

Configurations may be split into at most eight parent-first layers. A child
inherits its parent's validated fields and overrides only the fields it names;
relative `extends` paths are resolved from the child file. For example:

```json
{
  "extends": "../effectgate.base.json",
  "transaction_id": "reviewed-local-profile",
  "secret_refs": {
    "BACKEND_TOKEN": "env:EFFECTGATE_BACKEND_TOKEN"
  }
}
```

`secret_refs` maps an explicit backend environment name to an uppercase
`env:NAME` reference. The referenced value must be supplied by the process
environment that starts EffectGate. Values are resolved only in runtime memory,
are never written back to configuration, and cannot replace `PATH`, temporary
directory, or other base process variables. A missing reference fails before
the protected runtime creates state or starts a backend. Use `doctor --json` to
inspect the exact parent-to-child precedence in `configuration_layers` without
printing secret values.

This profile fixes the executable to the current Node binary, fixes argv to
the bundled fixture, fixes the working directory to `skill_root`, inherits
only the documented base environment plus configured secret references,
validates the exact MCP server and tool contracts, and persists fixture
idempotency records in
`stdio-effect-backend.db`.

Connect an MCP client using:

```text
node /absolute/path/to/EffectGate/poc/src/proxy/effectgate.mjs mcp skill serve --config /absolute/path/to/effectgate.json
```

The published tool hides and runtime-binds the transaction, Capsule,
capability revision, effect class, policy, idempotency adapter, and
verification probe. Only operation/receipt IDs, the declared patch arguments,
the exact resource scope, and a disclosure digest remain caller inputs.
On restart, never-dispatched operations are abandoned, interrupted dispatches
are reconciled through their persisted idempotency identity, verified commits
receive a deterministic recovery receipt, and ambiguous outcomes retain a
bounded verification budget without redispatch. Exhausted ambiguity requires
manual resolution. A completed one-phase configuration publishes no tools.

An effect call first returns `awaiting_approval`. Keep that MCP runtime running
and inspect the request through the operator-only Unix socket or Windows named
pipe. The command shows exact arguments and the bound intent digest:

```powershell
node .\poc\src\proxy\effectgate.mjs approve --config D:\path\to\effectgate.json --operation OPERATION_ID
node .\poc\src\proxy\effectgate.mjs approve --config D:\path\to\effectgate.json --operation OPERATION_ID --approver local-operator --intent sha256:REVIEWED_INTENT_DIGEST --yes
node .\poc\src\proxy\effectgate.mjs approve --config D:\path\to\effectgate.json --operation OPERATION_ID --deny
```

Exact arguments stay in runtime memory and are never added to the operation
journal. The local channel uses a user-only socket/pipe, bounded frames, and no
TCP listener. Approval consumes a single-use lease internally; its bearer token
is never printed or persisted. After approval, repeat the identical MCP call
with the same operation ID and arguments. Changed arguments fail admission.

If reconciliation cannot prove whether an effect committed, review it with the
plain `resolve` command shown above. Request one more verification-only attempt
without redispatching the effect:

```powershell
node .\poc\src\proxy\effectgate.mjs resolve --config D:\path\to\effectgate.json --operation OPERATION_ID --reconcile
node .\poc\src\proxy\effectgate.mjs resolve --config D:\path\to\effectgate.json --operation OPERATION_ID --manual --receipt RECEIPT_ID --note "operator evidence reference" --yes
```

The reviewed fixture permits at most three verification attempts within five
minutes. Each runtime or operator request spends at most one attempt.
Record an explicit manual outcome only after independent investigation.
EffectGate stores only a domain-separated digest of the note and issues a
`manual_resolution` receipt. It does not claim the effect committed.

After discovery:

1. Call `fixture__echo` for the typed pass-through path.
2. Call `fixture__large_log` with `{"lines": 200}` for a bounded Context View.
3. While `retrieval.more_available` is true, call `effectgate_fetch` with the
   returned cursor.
4. Call `effectgate_search` with the returned `artifact_id` and a literal query
   to retrieve cited context without paging through unrelated evidence.
5. Request `format: "jsonl"`, `"csv"`, or `"markdown"` from the fixture, then
   pass the returned `artifact_id` and matching format to `effectgate_project`.

For the redaction demonstration, add `"includeSecrets": true`. The fixture
inserts synthetic sentinels only; never substitute real credentials.

