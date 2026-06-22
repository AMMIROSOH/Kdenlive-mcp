# Architecture and data ownership

Kdenlive MCP is split into four TypeScript packages and one public server app:

```text
MCP client
   | stdio / authenticated loopback HTTP
apps/mcp-server
   | project operations          | render/inspection operations
packages/project-core            packages/render-core
   | ffprobe metadata            | melt + ffmpeg + ffprobe subprocesses
packages/runtime-probe ----------+ runtime discovery/capabilities
```

## Authoritative data

`project.json` is the portable canonical project. `state.sqlite` stores revisions,
history, checkpoints, and probe cache records adjacent to it. Render job SQLite,
logs, temporary MLT XML, previews, and export files are derived/operational data.
MLT XML and Kdenlive files are never imported as authoritative state in the current
release.

Mutations clone the current project, apply one gesture, validate it, atomically
commit one revision, and write canonical JSON. Callers must supply
`expectedRevision`; stale writes fail without changing state. Undo/redo is scoped
to the stable MCP client identity.

## Time and identity

Public timing uses integer project frames and rational frame rates. Entities use
stable UUIDs. Source ranges are half-open, and serialized objects use deterministic
ordering so equivalent projects compile byte-identically.

## Rendering

The compiler emits disposable MLT XML. The durable render manager invokes `melt`
without a shell, parses progress, bounds logs, handles cancellation/retry/restart,
and writes artifacts under the project root. FFmpeg and ffprobe generate previews
and verification reports.

## Deferred layers

The Python analysis worker is a health-only scaffold. It is not connected to the
MCP server. OTIO and Kdenlive project import/export are not implemented. These are
Milestones 5 and 6 respectively.
