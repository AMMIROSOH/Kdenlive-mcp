# Security policy

## Supported versions

Security fixes are provided for the latest `0.1.x` public-preview release and the
`main` branch. Older snapshots are unsupported.

## Reporting a vulnerability

Do not open a public issue for a vulnerability. Use GitHub's **Report a
vulnerability** flow in the Security tab to create a private security advisory.
Include the affected version, platform, reproduction, impact, and whether untrusted
media or a remote client is involved.

Maintainers should acknowledge a complete report within seven days. Timelines for
validation, fixes, CVEs, and disclosure depend on severity and upstream runtime
coordination. Please allow a reasonable remediation window before disclosure.

## Security boundary

Kdenlive MCP is a local process. The supported HTTP mode is loopback-only and is
not designed for LAN or internet exposure. Media parsers and renderers process
complex untrusted formats out of process; keep Kdenlive/MLT/FFmpeg updated and use
an unprivileged operating-system account. See the [threat model](docs/threat-model.md).
