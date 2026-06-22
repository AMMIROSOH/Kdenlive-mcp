# Third-party notices

No Kdenlive, MLT, FFmpeg, Node, font, model, or other third-party runtime binary is
committed or bundled in the public-preview archive. Package lockfiles, generated
production-license inventories, and release SBOMs are authoritative for the Node
application distribution.

| Component          | Intended use                           | Typical license                             | Distribution action                                                     |
| ------------------ | -------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| MLT / `melt`       | Out-of-process rendering               | LGPL-2.1-or-later; some modules differ      | Record build/modules, ship notices and corresponding source obligations |
| FFmpeg / ffprobe   | Out-of-process inspection and encoding | LGPL-2.1-or-later or GPL depending on build | Record configure flags/codecs; comply with the resulting build license  |
| Kdenlive           | Optional external review editor        | GPL-3.0-or-later                            | Do not bundle in v1; link users to its upstream distribution            |
| Node.js packages   | Application/build dependencies         | Per lockfile                                | Generate license report and SBOM for every release                      |
| MCP TypeScript SDK | MCP protocol transports and schemas    | MIT                                         | Retain license notice and pin the tested protocol version               |
| Python packages    | Analysis worker dependencies           | Per lockfile                                | Generate license report and SBOM for every release                      |

`pnpm licenses:report` generates the exact locked production package inventory.
Before bundling any external runtime, complete the checklist in ADR 0001 and add
notices, corresponding-source offers, build flags, modules, codecs, and provenance
for the exact shipped binaries.
