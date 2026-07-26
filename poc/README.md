# EffectGate preview

This dependency-free Node.js preview proves two narrow paths:

```text
small typed result  -> unchanged MCP result
large text result   -> temporary filesystem CAS -> redacted view
retained artifact   -> fetch / literal search / JSON or JSONL projection
                    -> CSV or TSV projection / Markdown heading extraction
```

It remains fixture-only. Arbitrary backends, protected effects, real
secret-bearing data, and production use are disabled.

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
| `fixture__large_log` | Deterministic multibyte log, JSONL, CSV, or Markdown data and synthetic redaction sentinels |
| `effectgate_fetch` | Local continuation using an authenticated opaque cursor |
| `effectgate_search` | Bounded literal context search over a retained artifact |
| `effectgate_project` | Bounded JSON/JSONL, CSV/TSV, or Markdown projection |

Try `fixture__large_log` with `{"lines": 200}`. If the returned Context View
reports `retrieval.more_available: true`, pass its cursor to
`effectgate_fetch`. Without redaction matches, concatenating each cited page
reconstructs the original log exactly. Add `"includeSecrets": true` to verify
that documented synthetic sentinels are removed from every emitted page.

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

## Bounds

| Resource | Limit |
|---|---:|
| JSON-RPC frame | 1 MiB |
| Serialized tool-result value | 64 KiB |
| Context View source content | 4,096 bytes per page |
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
| Detected redaction spans | 4,096 per artifact; excess fails closed |
| Cursor token | 2 KiB maximum / HMAC-SHA256 authenticated |
| Cursor states | 64; live continuations are pinned |
| Cursor lifetime | 10 minutes; recent same-session retries are cached |
| Forwarded backend requests | 64 pending / 10 seconds each |

The filesystem objects are atomically finalized and verified before every
page read. Session metadata remains volatile and process-local, and backend
results still arrive as complete strings. The preview has no durable index,
end-to-end streaming adapter, comprehensive secret/PII detection, regex/ranked
search, JSONPath or richer predicates, full CommonMark structure, token ledger,
approval flow, fuzz qualification, or production support claim.
