# Kdenlive MCP

Local-first video editing through the Model Context Protocol. Kdenlive MCP keeps
a versioned JSON project as the source of truth, applies revision-checked timeline
edits, compiles deterministic MLT, queues renders, generates previews, and verifies
outputs using the Kdenlive/MLT and FFmpeg installation already on your computer.

> Public preview: Milestones 0-4 and 7 are implemented. Local AI analysis
> (Milestone 5) and Kdenlive/OTIO round-trip interoperability (Milestone 6) are
> planned and clearly marked as unavailable.

## What works

- Canonical projects with atomic revisions, checkpoints, undo, and redo.
- Media ingest with allowed-root containment and managed/external modes.
- Clip placement, linked A/V, ripple edits, properties, keyframes, effects,
  transitions, text, captions, and markers.
- Durable preview/export jobs, progress, cancellation, restart recovery, and
  bounded artifacts.
- Output duration, stream, A/V sync, loudness, clipping, black, and freeze checks.
- MCP over stdio or authenticated loopback Streamable HTTP.
- Automatic Kdenlive/MLT/FFmpeg discovery and an actionable doctor command.

## Quick start

Requirements: Node.js 22+, pnpm 9, and Kdenlive or separate MLT/FFmpeg tools.

```powershell
git clone https://github.com/AMMIROSOH/Kdenlive-mcp.git
cd Kdenlive-mcp
Set-ExecutionPolicy -Scope Process Bypass
.\scripts\install.ps1 -AddToPath
kdenlive-mcp --doctor
```

Linux:

```sh
git clone https://github.com/AMMIROSOH/Kdenlive-mcp.git
cd Kdenlive-mcp
./scripts/install.sh
~/.local/share/kdenlive-mcp/kdenlive-mcp-*/kdenlive-mcp --doctor
```

Then add the stdio command to your MCP client with an absolute allowed root:

```text
kdenlive-mcp --root /path/to/video-workspace --client-id my-mcp-client
```

See the complete [installation and client configuration guide](INSTALL.md).

## Safety model

- Files are limited to configured roots; symlink/traversal escapes are rejected.
- Mutations require the exact current revision and remain undoable per client.
- Render processes use argument arrays, no shell, bounded output/time, and a
  restricted environment.
- HTTP binds only to loopback and requires a generated bearer token.
- Kdenlive, MLT, and FFmpeg binaries are not redistributed by this repository.

Read the [threat model](docs/threat-model.md) and [security policy](SECURITY.md)
before exposing the server to additional software.

## Documentation

- [Installation](INSTALL.md)
- [Tutorial](docs/tutorial.md)
- [MCP reference](docs/mcp-reference.md)
- [Architecture and data ownership](docs/architecture.md)
- [Runtime support](docs/runtime-support.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md)

## Development

```shell
pnpm install --frozen-lockfile
pnpm check
pnpm doctor
pnpm render:acceptance
pnpm mcp:acceptance
pnpm docs:check
pnpm sbom
pnpm release:acceptance -- --platform windows
```

## License

Apache-2.0 for this repository. External Kdenlive/MLT/FFmpeg installations retain
their own licenses; see [third-party notices](THIRD_PARTY_NOTICES.md).
