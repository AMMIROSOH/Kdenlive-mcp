# Runtime support matrix

| Platform          | Status             | Node | Kdenlive / MLT                | FFmpeg                      |
| ----------------- | ------------------ | ---- | ----------------------------- | --------------------------- |
| Windows 10/11 x64 | Tested             | 22+  | Kdenlive 26.04.2 / MLT 7.39.0 | Kdenlive FFmpeg 8.0.1       |
| Ubuntu 24.04 x64  | CI tested          | 22+  | Distribution `melt` package   | Distribution FFmpeg package |
| macOS             | Unsupported        | —    | —                             | —                           |
| ARM               | Not release-tested | —    | —                             | —                           |

The machine-readable policy is [runtime-manifest.json](../config/runtime-manifest.json).
`kdenlive-mcp --doctor` is authoritative for one installation: it probes actual
executables, versions, services, filters, transitions, codecs, and encoders.

The first public release uses external runtimes. This avoids silently shipping a
Kdenlive/MLT/FFmpeg build whose module and codec licenses have not been audited as
one distributable bundle. Future self-contained runtime archives require exact
source offers, configure flags, module inventories, notices, and legal review.
