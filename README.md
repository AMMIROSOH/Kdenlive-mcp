# Kdenlive MCP

Foundation for a headless video editor that keeps a portable JSON project as its
source of truth, compiles disposable MLT XML, and uses Kdenlive for review.

Milestone 0 covers feasibility only: architecture/licensing decisions, repository
tooling, runtime discovery, and a deterministic 30-second rendering spike. The
complete implementation sequence is in [`docs/roadmap.md`](docs/roadmap.md), and
[`docs/milestone-0.md`](docs/milestone-0.md) tracks current foundation status.
Milestone 1 implementation status and project-format rules are documented in
[`docs/milestone-1.md`](docs/milestone-1.md) and
[`docs/project-schema.md`](docs/project-schema.md).

## Prerequisites

- Node.js 22 or newer and pnpm 9
- Python 3.12 for the future analysis worker
- FFmpeg/ffprobe and MLT 7.38 (`melt`) on `PATH` for runtime/spike checks

```shell
pnpm install
pnpm check
pnpm capabilities -- --output artifacts/capabilities.json
pnpm fixtures:milestone-1 -- --require-runtime
pnpm test:runtime
pnpm spike:prepare
pnpm spike:render
```

On Windows, the standard `C:\Program Files\Kdenlive` installation is discovered
automatically. A portable installation can be selected with `KDENLIVE_ROOT` or
`MLT_ROOT`; exact overrides are `MELT_PATH`, `FFMPEG_PATH`, and `FFPROBE_PATH`.

## Scope

No MCP server or editable project schema exists yet. Those begin in later
milestones; adding them to this spike would prematurely freeze public contracts.
