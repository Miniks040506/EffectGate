# EffectGate Phase 0 PoC

This disposable PoC proves the smallest useful EffectGate path:

```text
MCP host -> bounded stdio proxy -> deterministic MCP backend
```

It is pre-SG-1 evidence, not the production `M0 Contracts` milestone.

Run the checks:

```powershell
cd poc
npm test
```

Run the proxy against its deterministic fixture:

```powershell
node effectgate.mjs mcp serve
```

Phase 0 exposes only explicitly read-only, idempotent, closed-world fixture
tools. Arbitrary backends and protected effects are disabled until policy,
approval, journaling, and reconciliation exist.

Phase 0 intentionally contains no SQLite, CAS, projection, approval, daemon,
installer, or production support claim.
