# Milestone 4: MCP server and safety

Milestone 4 is implemented in `apps/mcp-server` using the pinned
`@modelcontextprotocol/sdk` 1.29.0. The server exposes the canonical project,
timeline, media, preview, render, verification, and artifact APIs without making
MLT XML or Kdenlive project files authoritative.

## 4.1 MCP transports

- [x] Pin the TypeScript SDK and test protocol initialization with its real client.
- [x] Provide stdio with stdout reserved exclusively for MCP messages.
- [x] Provide optional Streamable HTTP bound only to `127.0.0.1` or `::1`.
- [x] Generate a 256-bit bearer token in a mode-0600 state file.
- [x] Validate bearer auth, Host, Origin, content type, protocol version, method, body size, session ID, and session count.
- [x] Handle GET/POST/DELETE sessions and graceful process shutdown.

Run stdio:

```shell
pnpm mcp:start -- --root C:\path\to\allowed-root --client-id my-client
```

Run authenticated loopback HTTP:

```shell
pnpm mcp:start -- --http --root C:\path\to\allowed-root --port 8765
```

The generated token path is printed to stderr. HTTP sessions authenticated with
the same token are one ownership principal; stdio ownership uses `--client-id`.

## 4.2 Project and media tools

- [x] Return consistent `{ok,data}` or `{ok:false,error}` envelopes.
- [x] Expose create/open/get/validate/checkpoint/restore tools.
- [x] Expose assistant-scoped undo/redo with required revisions.
- [x] Expose bounded allowed-root media import/list/inspect tools.
- [x] Return structured revision conflicts, validation errors, changed IDs, warnings, and undo tokens.
- [x] Publish compact project and installed profile resources.

## 4.3 Timeline tools

- [x] Expose compact filtered timeline queries.
- [x] Expose add/move/remove/split/trim/slip/speed/ripple gestures.
- [x] Expose clip properties, keyframes, effects, and transitions.
- [x] Expose text, caption, marker, and caption-export tools.
- [x] Route every mutation through `ProjectStore`, validation, revision checks, and undo history.

## 4.4 Render and job tools

- [x] Submit nonblocking frame/range/audio previews and exports.
- [x] Persist ownership adjacent to the durable render queue.
- [x] Expose owned job get/list/cancel/verify operations.
- [x] Expose successful artifacts through bounded `kdenlive://artifacts/{jobId}` resources.
- [x] Preserve queued work across server restart and retain bounded render logs.

Waveforms and contact sheets use the cached inspection tool because they require
post-processing; frame, range, and audio previews use the durable render queue.

## 4.5 Agent instructions

- [x] Publish `kdenlive://instructions` with frame math, IDs, and revision rules.
- [x] Document inspect-before-edit, batching, linkage, ripple, previews, jobs, and recovery.
- [x] Test instruction and profile resources through an SDK client.

## 4.6 Security hardening

- [x] Contain projects, media, and artifacts to configured roots.
- [x] Reject traversal, unsafe artifact names, URLs, and cross-client job access.
- [x] Execute runtime commands with argument arrays, no shell, bounded output/time, and an environment allowlist.
- [x] Bound requests, sessions, tools arrays, media discovery, preview duration, logs, and resource artifacts.
- [x] Disable non-loopback HTTP and unrestricted network media imports.
- [x] Test missing auth, hostile Origin, unsupported protocol, oversized bodies, injection strings, stale revisions, and ownership denial.

## Acceptance

```shell
pnpm check
pnpm mcp:acceptance
```

The acceptance client connects over a real stdio subprocess, creates a project,
imports synthetic A/V media, places linked clips, adds text, submits and reads a
preview, submits a lossless export, and verifies duration, streams, A/V sync,
loudness, black frames, and freeze frames. The local run passed against Kdenlive
26.04.2, MLT 7.39.0, and FFmpeg/ffprobe 8.0.1. Evidence is written to
`artifacts/milestone-4-acceptance/acceptance-report.json`.

Milestone 5 can add local analysis jobs and tools. It must use the same ownership,
path-containment, bounded-message, cancellation, and source/timeline mapping rules.
