# Reviewed Streamable HTTP JSON bridge

This v1.1 preview connects EffectGate's existing reviewed stdio boundary to a
read-only MCP Streamable HTTP endpoint. It deliberately supports the
`application/json` response mode of MCP `2025-11-25` only. SSE responses,
server-initiated requests, writes, redirects, and protocol `2026-07-28` are
rejected rather than guessed.

The bridge:

- permits HTTPS endpoints and cleartext HTTP only on loopback;
- rejects URL credentials and fragments;
- sends the required JSON and SSE `Accept` values but accepts JSON responses
  only;
- preserves a bounded visible-ASCII `MCP-Session-Id` and sends the pinned
  protocol header after initialization;
- bounds each response to 1 MiB and each request to nine seconds;
- accepts one optional environment-supplied `Authorization` header;
- suppresses remote errors through EffectGate's existing public error path;
- remains behind exact bridge/source, identity, and immutable safe-read catalog
  review.

It is not remote process attestation. A reviewer must independently establish
who operates the endpoint and whether its declared safe-read tools are honest.

## Reviewed configuration

Use the existing `effectgate.reviewed.stdio-read.v1` configuration. Pin the
current Node executable, this bridge, any locally reviewable backend materials,
the remote server identity, and its exact single-page catalog. The relevant
shape is:

```json
{
  "schema_version": "1.0.0",
  "driver": "effectgate.reviewed.stdio-read.v1",
  "source": "remote",
  "executable_path": "ABSOLUTE_NODE_PATH",
  "executable_digest": "sha256:PINNED_NODE_DIGEST",
  "argv": [
    "ABSOLUTE_EFFECTGATE_PATH/poc/src/proxy/streamable-http-json-bridge.mjs",
    "https://reviewed.example/mcp",
    "--authorization-env",
    "BACKEND_AUTHORIZATION"
  ],
  "working_directory": "ABSOLUTE_REVIEWED_DIRECTORY",
  "source_files": [
    {
      "path": "ABSOLUTE_EFFECTGATE_PATH/poc/src/proxy/streamable-http-json-bridge.mjs",
      "digest": "sha256:PINNED_BRIDGE_DIGEST"
    }
  ],
  "server_identity": {
    "name": "REVIEWED_SERVER_NAME",
    "version": "REVIEWED_SERVER_VERSION"
  },
  "catalog": {
    "tools": []
  },
  "secret_refs": {
    "BACKEND_AUTHORIZATION": "env:EFFECTGATE_REMOTE_AUTHORIZATION"
  }
}
```

Replace the empty catalog with at least one exact safe-read tool carrying all
four required annotations. Remove the authorization argv and `secret_refs`
when the endpoint needs no credential. Never put an authorization value in the
configuration or command line.

Run the reviewed profile through the normal command:

```text
effectgate mcp serve --config /absolute/path/to/reviewed-http.json
```

The current bridge is intentionally not a general web proxy. Add full SSE,
modern MCP `2026-07-28`, OAuth discovery, or write-capable endpoints only as
separate reviewed and qualified changes.
