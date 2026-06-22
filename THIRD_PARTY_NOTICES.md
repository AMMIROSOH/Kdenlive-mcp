# Third-party notices (development inventory)

No third-party runtime binaries are currently committed to this repository.
Package lockfiles and release SBOMs are authoritative for actual distributions.

| Component          | Intended use                           | Typical license                             | Distribution action                                                     |
| ------------------ | -------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------------- |
| MLT / `melt`       | Out-of-process rendering               | LGPL-2.1-or-later; some modules differ      | Record build/modules, ship notices and corresponding source obligations |
| FFmpeg / ffprobe   | Out-of-process inspection and encoding | LGPL-2.1-or-later or GPL depending on build | Record configure flags/codecs; comply with the resulting build license  |
| Kdenlive           | Optional external review editor        | GPL-3.0-or-later                            | Do not bundle in v1; link users to its upstream distribution            |
| Node.js packages   | Application/build dependencies         | Per lockfile                                | Generate license report and SBOM for every release                      |
| MCP TypeScript SDK | MCP protocol transports and schemas    | MIT                                         | Retain license notice and pin the tested protocol version               |
| Python packages    | Analysis worker dependencies           | Per lockfile                                | Generate license report and SBOM for every release                      |

Before bundling any runtime, complete the checklist in ADR 0001 and replace this
development inventory with notices generated from the exact shipped artifacts.
