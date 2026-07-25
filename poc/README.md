# EffectGate preview

This dependency-free Node.js preview proves two narrow paths:

```text
small typed result  -> unchanged MCP result
large text result   -> in-memory artifact -> cited Context View -> fetch pages
```

It remains fixture-only. Arbitrary backends, protected effects, secret-bearing
data, and production use are disabled.

## Run

```powershell
cd poc
npm test
npm start
```

Point an MCP stdio client at:

```text
node /absolute/path/to/EffectGate/poc/effectgate.mjs mcp serve
```

The fixture exposes:

| Tool | Purpose |
|---|---|
| `fixture__echo` | Typed small-result pass-through |
| `fixture__echo_again` | Catalog pagination |
| `fixture__large_log` | Deterministic multibyte text for bounded paging |
| `effectgate_fetch` | Local continuation using an opaque cursor |

Try `fixture__large_log` with `{"lines": 200}`. If the returned Context View
reports `retrieval.more_available: true`, pass its cursor to
`effectgate_fetch`. Concatenating each cited page reconstructs the original log
exactly.

## Bounds

| Resource | Limit |
|---|---:|
| JSON-RPC frame | 1 MiB |
| Serialized tool-result value | 64 KiB |
| Context View source content | 4,096 bytes per page |
| Stored artifact | 1 MiB |
| In-memory artifact store | 4 MiB / 16 artifacts |
| Cursor states | 64; live continuations are pinned |
| Cursor lifetime | 10 minutes; recent same-session retries are cached |
| Forwarded backend requests | 64 pending / 10 seconds each |

The Context Store is volatile and process-local. It has no persistence,
streaming ingestion, redaction, search, structured projection, token ledger,
approval flow, or production support claim.
