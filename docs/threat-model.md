# Threat model

## Assets

- User media, project timelines, captions, and output artifacts.
- Filesystem paths and metadata that may reveal private information.
- MCP HTTP bearer tokens and client-scoped undo/job ownership.
- Host resources consumed by parsers and render processes.

## Trust boundaries

MCP clients are trusted to request edits within one configured root, but requests
are still schema/size/revision validated. Imported media and metadata may be
hostile. Kdenlive/MLT/FFmpeg are external native processes and are not considered
memory-safe components. Loopback HTTP clients must possess the bearer token.

## Controls

- Canonical/real path containment, symlink checks, and safe artifact names.
- No URL media import and no non-loopback HTTP bind.
- Bearer authentication, Host/Origin/protocol/content-type checks, body/session limits.
- Shell-free argument arrays, executable discovery without command interpolation,
  restricted child environments, timeouts, process-tree cancellation, and bounded logs.
- Exact revision preconditions, validation before commit, client-scoped undo/jobs.
- Bounded timeline responses, media discovery, preview ranges, and artifact reads.

## Residual risk

- A vulnerability in Kdenlive/MLT/FFmpeg may be triggered by hostile media.
- A process running as the same OS user may read the token or project files.
- Stdio clients have the permissions of the launching user.
- Content analysis does not currently detect every malicious or misleading media case.
- The project has not completed an independent security audit.

Run under an unprivileged user, restrict allowed roots, keep runtimes updated, and
do not expose HTTP through port forwarding, containers, or reverse proxies.
