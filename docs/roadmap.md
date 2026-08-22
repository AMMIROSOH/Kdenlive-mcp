# Implementation roadmap

This is the execution map for Milestones 0–7. Each leaf task is intended to fit
one focused implementation session and produce a reviewable artifact or test.
Issue IDs remain stable; suffixes identify the smaller work chunks.

Status lives in the milestone documents and issue tracker, not in this overview.
Detailed status is recorded in the matching `milestone-N.md` document. Milestones
0 through 4 are implemented, Milestones 5 and 6 are coming soon/TODO, and
Milestone 7 packages the implemented core as a public preview.

## Working order

1. Finish Milestone 0 environment acceptance: `0.3.f`, `0.4.f`, and `0.4.g`.
   Legal review `0.1.d` is required before binary distribution, not before model work.
2. Start `1.1.a` and complete Milestone 1 in issue order, except `1.5` fixtures
   should grow alongside `1.1`–`1.4`.
3. Do not publish MCP mutation tools until revision checks, validation, and undo
   semantics are complete.
4. Do not claim a milestone complete until its exit criterion and platform checks pass.

## Global engineering rules

- Canonical state is versioned JSON. SQLite stores adjacent operational state;
  MLT XML and Kdenlive files are generated/imported representations.
- Public timing uses integer project frames and explicit rational frame rates.
- IDs are stable UUIDs. Mutations are atomic, revision-checked, validated, and undoable.
- External commands use argument arrays without a shell, bounded output, timeouts,
  cancellation, and sanitized logs.
- Capability-dependent behavior returns explicit warnings or errors; it never
  silently drops unsupported media, effects, or editor data.
- Tests use synthetic or redistributable fixtures and run on Windows and Linux.
- New third-party dependencies require license review and notice/SBOM coverage.

## Milestone 0 — Feasibility and foundation

Detailed implementation and pending acceptance tasks are tracked in
[`milestone-0.md`](milestone-0.md).

Exit: the deterministic 30-second sample renders on pinned Windows and Linux
runtimes, decoded hashes match, capability snapshots are retained, and the
distribution licensing checklist has an owner.

## Milestone 1 — Project and media foundation

### 1.1 Versioned project schema

- `1.1.a` Define rational FPS, frame/time, resolution, audio, color, and export primitives.
- `1.1.b` Define Zod schemas and TypeScript types for project, asset, track, clip,
  effect, transition, caption, marker, and keyframe entities.
- `1.1.c` Add UUID generation/validation and cross-reference integrity helpers.
- `1.1.d` Implement canonical JSON serialization with deterministic key/order policy.
- `1.1.e` Implement supported-version loading and reject unknown future versions.
- `1.1.f` Add migration registry and one fixture-backed example migration.
- `1.1.g` Add exact frame/seconds/timecode conversion and boundary tests.
- `1.1.h` Publish schema examples and compatibility rules.

Acceptance: valid projects round-trip byte-stably, migrations are deterministic,
future versions fail clearly, and frame math passes boundary/property tests.

### 1.2 Transaction and revision store

- `1.2.a` Define repository interfaces for projects, revisions, transactions, and history.
- `1.2.b` Add SQLite schema, migrations, connection lifecycle, WAL, and busy handling.
- `1.2.c` Implement crash-safe canonical JSON writes using temporary files and atomic replace.
- `1.2.d` Implement optimistic `expectedRevision` checks and structured conflicts.
- `1.2.e` Record atomic mutations with changed IDs, warnings, actor, and timestamp.
- `1.2.f` Add named checkpoints and checkpoint restore as new revisions.
- `1.2.g` Implement assistant-scoped undo tokens and redo chains.
- `1.2.h` Test crashes, stale revisions, concurrent writers, and history isolation.

Dependencies: `1.1`. Acceptance: no successful mutation can leave JSON, SQLite,
or history at conflicting revisions.

### 1.3 Media ingest

- `1.3.a` Define allowed-root policy and canonical cross-platform path representation.
- `1.3.b` Implement file/directory discovery with traversal and symlink containment checks.
- `1.3.c` Add streaming content hashing, duplicate detection, and stable asset IDs.
- `1.3.d` Wrap ffprobe JSON invocation with timeout, limits, and typed parsing.
- `1.3.e` Normalize video, audio, image, duration, frame-rate, rotation, and color metadata.
- `1.3.f` Implement external-reference and managed-copy import modes.
- `1.3.g` Persist probe/hash cache records and invalidate stale entries.
- `1.3.h` Test missing, malformed, duplicate, VFR, rotated, and Unicode-path media.

Dependencies: `1.1`, `1.2`, runtime probe. Acceptance: ingest is repeatable,
root-contained, deduplicated, and never constructs a shell command.

### 1.4 Project validator

- `1.4.a` Define diagnostic codes, severity, entity paths, and fix hints.
- `1.4.b` Validate schema, references, timing, trims, and frame bounds.
- `1.4.c` Validate track types, placement, overlap, linkage, and transition adjacency.
- `1.4.d` Validate media availability and source-duration compatibility.
- `1.4.e` Validate effects/codecs against the captured runtime capability snapshot.
- `1.4.f` Add full-project and changed-entity incremental validation.
- `1.4.g` Add malformed-project and capability-mismatch regression tests.

Dependencies: `1.1`, `1.3`. Acceptance: diagnostics are deterministic and every
mutation can invoke the same validator before commit.

### 1.5 Fixture library

- `1.5.a` Add deterministic generators for video, audio, image, title, and caption fixtures.
- `1.5.b` Add VFR, rotated, multichannel, odd-dimension, and color-metadata fixtures.
- `1.5.c` Add missing-media, corrupt-media, and malformed-project fixtures.
- `1.5.d` Add fixture provenance, licenses, checksums, and regeneration commands.
- `1.5.e` Keep large generated binaries out of Git and cache them in CI.

Acceptance: fixtures regenerate deterministically and cover every Milestone 1
error class without relying on private media.

Milestone 1 exit: create, migrate, persist, reopen, ingest, and validate a project;
prove stale writes, crashes, and malformed media cannot corrupt state.

## Milestone 2 — Timeline editing engine

### 2.1 Timeline query model

- `2.1.a` Define compact timeline/project summary response schemas.
- `2.1.b` Add frame-window, track, entity-ID, and detail-level query filters.
- `2.1.c` Return clip linkage, source/timeline ranges, effects, transitions, and markers.
- `2.1.d` Add pagination/size limits and stable ordering.
- `2.1.e` Add representative agent-context snapshots and token-size tests.

Dependencies: Milestone 1. Acceptance: a caller can inspect relevant state and
revision without loading the entire project.

### 2.2 Placement operations

- `2.2.a` Define placement command/result and collision-policy schemas.
- `2.2.b` Implement track creation and compatible-track selection.
- `2.2.c` Implement append/add placement for single and batched clips.
- `2.2.d` Implement overwrite placement with deterministic split/removal behavior.
- `2.2.e` Implement insert placement with ripple movement.
- `2.2.f` Implement linked video/audio placement and linkage metadata.
- `2.2.g` Add overlap, boundary, batch-order, and revision/undo tests.

### 2.3 Structural edits

- `2.3.a` Implement move and remove with explicit collision behavior.
- `2.3.b` Implement split with property, effect, keyframe, and linkage propagation.
- `2.3.c` Implement head/tail trim and source-bound validation.
- `2.3.d` Implement slip without changing timeline placement.
- `2.3.e` Implement speed changes with exact duration rounding rules.
- `2.3.f` Implement batched ripple-delete ranges with normalization/merging.
- `2.3.g` Implement sync-locked track and linked-clip movement rules.
- `2.3.h` Add property-based invariants for overlaps, duration, links, undo, and determinism.

Dependencies: `2.2`. Acceptance: structural operations never produce invalid
intermediate or committed state.

### 2.4 Properties and animation

- `2.4.a` Define typed clip properties and default inheritance.
- `2.4.b` Implement transform, crop, opacity, volume, pan, and fade mutations.
- `2.4.c` Define keyframe coordinates, interpolation, and duplicate-frame policy.
- `2.4.d` Implement linear, hold, and smooth keyframe CRUD.
- `2.4.e` Transform keyframes correctly through trim, split, slip, and speed changes.
- `2.4.f` Validate value ranges and add serialization/undo tests.

### 2.5 Effects and transitions

- `2.5.a` Normalize probed MLT metadata into a versioned effect catalog.
- `2.5.b` Define effect instance schemas, typed parameters, defaults, and enable/bypass state.
- `2.5.c` Add documented raw MLT-property escape hatch with capability warnings.
- `2.5.d` Implement ordered add/update/remove/replace effect gestures.
- `2.5.e` Define transition adjacency, duration, alignment, and track rules.
- `2.5.f` Implement add/update/remove transitions with collision validation.
- `2.5.g` Add catalog-version, unavailable-service, and round-trip tests.

### 2.6 Text, captions, and markers

- `2.6.a` Define text style, anchor, safe-area, and background schemas.
- `2.6.b` Implement title/lower-third placement and updates.
- `2.6.c` Define caption track, cue, style, overlap, and reading-speed rules.
- `2.6.d` Implement caption CRUD and SRT/VTT import/export primitives.
- `2.6.e` Implement chapter, comment, and generic marker CRUD.
- `2.6.f` Add YouTube chapter export and safe-area diagnostics.

Milestone 2 exit: every gesture is batched, atomic, revision-checked, reversible,
deterministic, and property-tested against timeline invariants.

## Milestone 3 — Rendering and inspection

Implementation and acceptance evidence are tracked in
[`milestone-3.md`](milestone-3.md).

### 3.1 MLT compiler

- `3.1.a` Define compiler input/output contracts and deterministic XML utilities.
- `3.1.b` Compile profile, assets, producers, playlists, tracks, and tractors.
- `3.1.c` Compile trims, speed, transforms, crop, opacity, and audio routing.
- `3.1.d` Compile effects, transitions, and raw-property escape values.
- `3.1.e` Compile linear/hold/smooth keyframes with exact frame mapping.
- `3.1.f` Compile text, captions, markers, and project metadata.
- `3.1.g` Add capability validation and fidelity warnings before compilation.
- `3.1.h` Add golden XML and decoded-frame/audio regression tests.

Dependencies: Milestone 2. Acceptance: the same project and capability snapshot
produce byte-identical XML.

### 3.2 Render job manager

- `3.2.a` Define persisted job, state, progress, result, and error schemas.
- `3.2.b` Implement SQLite-backed queue claiming and concurrency limits.
- `3.2.c` Spawn isolated render processes without a shell and parse progress.
- `3.2.d` Add bounded logs, environment allowlist, and sanitized diagnostics.
- `3.2.e` Implement cooperative cancellation and process-tree termination.
- `3.2.f` Implement retry policy and distinguish transient/permanent failures.
- `3.2.g` Add temp-workspace lifecycle and orphan cleanup after restart.
- `3.2.h` Test cancellation, crashes, full disk, retry, and recovery.

### 3.3 Preview pipeline

- `3.3.a` Render one composited frame at an exact project frame.
- `3.3.b` Render bounded contact sheets with labels and deterministic sampling.
- `3.3.c` Render low-resolution proxy ranges with audio.
- `3.3.d` Generate waveform and audio-only preview artifacts.
- `3.3.e` Add preview caching keyed by revision, range, profile, and capabilities.
- `3.3.f` Enforce artifact size, duration, and concurrent-preview limits.

### 3.4 Export profiles

- `3.4.a` Define versioned profile schema and compatibility constraints.
- `3.4.b` Add YouTube 1080p, 1440p, and 4K profiles.
- `3.4.c` Add vertical Shorts, mezzanine, audio-only, and caption profiles.
- `3.4.d` Add validated custom profiles without raw command fragments.
- `3.4.e` Resolve unavailable codecs with explicit fallback/error policy.
- `3.4.f` Publish profile catalog resource and fixture exports.

### 3.5 Output verification

- `3.5.a` Probe output duration, streams, codecs, dimensions, FPS, and sample rate.
- `3.5.b` Verify expected timeline duration and audio/video synchronization.
- `3.5.c` Measure loudness, true peak, clipping, and silent output.
- `3.5.d` Detect configurable black-frame, freeze-frame, and missing-stream failures.
- `3.5.e` Return structured verification diagnostics and retain reports with jobs.
- `3.5.f` Add known-good and intentionally defective output fixtures.

Milestone 3 exit: queued preview/export jobs survive restart and produce verified,
reproducible outputs or actionable structured failures on both platforms.

## Milestone 4 — MCP server and safety

Implementation and acceptance evidence are tracked in
[`milestone-4.md`](milestone-4.md).

### 4.1 MCP transports

- `4.1.a` Pin MCP SDK production version and add protocol compatibility tests.
- `4.1.b` Implement stdio server lifecycle, logging isolation, and graceful shutdown.
- `4.1.c` Implement optional Streamable HTTP bound only to `127.0.0.1`/`::1`.
- `4.1.d` Generate/store bearer tokens with restrictive permissions.
- `4.1.e` Validate authorization, Origin, Host, content type, protocol version, and size.
- `4.1.f` Add concurrent-session, disconnect, timeout, and shutdown tests.

### 4.2 Project and media tools

- `4.2.a` Define common MCP success/error/revision/warning envelopes.
- `4.2.b` Publish project create/open/get/validate/checkpoint tools.
- `4.2.c` Publish project undo/redo with assistant/session identity.
- `4.2.d` Publish media import/list/inspect tools.
- `4.2.e` Add progress, cancellation, concise errors, and structured content.
- `4.2.f` Publish project summary and installed-capability resources.

### 4.3 Timeline tools

- `4.3.a` Publish compact timeline query tool.
- `4.3.b` Publish batched add/insert/move/remove/split tools.
- `4.3.c` Publish ripple delete and clip-property tools.
- `4.3.d` Publish keyframe, effect, and transition tools.
- `4.3.e` Publish text, caption, and marker tools.
- `4.3.f` Add schema snapshots and stale-revision/undo integration tests.

### 4.4 Render and job tools

- `4.4.a` Publish nonblocking preview and export submission tools.
- `4.4.b` Publish job get/list/cancel tools with ownership checks.
- `4.4.c` Map MCP progress notifications to durable job progress.
- `4.4.d` Expose verified output/preview artifacts through bounded resources.
- `4.4.e` Add restart, cancellation, concurrent client, and large-log tests.

### 4.5 Agent instructions

- `4.5.a` Document frame math, rational FPS, IDs, and revision preconditions.
- `4.5.b` Document inspect-before-edit and compact query patterns.
- `4.5.c` Document linked media, ripple/sync-lock behavior, and risky gestures.
- `4.5.d` Add efficient batching, preview, render, and recovery recipes.
- `4.5.e` Test instructions against representative client workflows.

### 4.6 Security hardening

- `4.6.a` Threat-model local transports, file access, media parsing, and process execution.
- `4.6.b` Test path traversal, symlink escape, unsafe URLs, and root-policy bypasses.
- `4.6.c` Test command/argument injection and hostile metadata/log content.
- `4.6.d` Enforce request, response, log, artifact, runtime, and concurrency limits.
- `4.6.e` Disable unrestricted network imports and non-loopback HTTP access.
- `4.6.f` Add dependency/secret scanning and a private reporting policy.

Milestone 4 exit: supported clients complete project, edit, and render workflows
over stdio and authenticated loopback HTTP; the security suite passes.

## Milestone 5 — Local media intelligence

**Status: TODO / coming soon. Not included in the public preview.**

### 5.1 Analysis worker protocol

- `5.1.a` Define versioned JSON-RPC-over-stdio request/result/error schemas.
- `5.1.b` Implement TypeScript supervisor and Python dispatcher.
- `5.1.c` Add startup handshake, health, capability, and model inventory methods.
- `5.1.d` Add progress, cancellation, timeouts, bounded messages, and stderr logs.
- `5.1.e` Add crash restart/backoff and CPU/memory/concurrency controls.
- `5.1.f` Implement model download/storage policy with checksums and offline mode.
- `5.1.g` Add CPU baseline and protocol conformance tests.

### 5.2 Transcription

- `5.2.a` Package faster-whisper with explicit model/device/compute selection.
- `5.2.b` Produce language, segments, words, confidence, and source timestamps.
- `5.2.c` Cache results by asset hash, audio stream, model, and settings.
- `5.2.d` Map source timestamps through trim/speed into timeline frame ranges.
- `5.2.e` Expose transcription jobs and transcript inspection/search.
- `5.2.f` Test silence, multiple languages, trims, speed changes, and cancellation.

### 5.3 Visual and audio inspection

- `5.3.a` Detect scene boundaries and choose representative frames.
- `5.3.b` Detect silence, loudness, clipping, and speech-density ranges.
- `5.3.c` Estimate motion/activity with configurable sampling.
- `5.3.d` Cache analysis by asset hash and algorithm version.
- `5.3.e` Map findings to source and timeline ranges.
- `5.3.f` Add deterministic fixtures, tolerance rules, and CPU performance budgets.

### 5.4 Semantic search

- `5.4.a` Select/license local text and visual embedding models.
- `5.4.b` Define chunking/sampling, embedding metadata, and model-version keys.
- `5.4.c` Store/search embeddings locally with deterministic ranking/tie-breaking.
- `5.4.d` Combine transcript and visual results with filters and score explanations.
- `5.4.e` Return asset/source ranges directly usable by placement tools.
- `5.4.f` Add relevance fixtures, index rebuild, cancellation, and CPU tests.

### 5.5 Caption workflow

- [x] `5.5.a` Convert transcript words into editable caption cues.
- [x] `5.5.b` Apply line length, duration, gap, reading-speed, and safe-area rules.
- [x] `5.5.c` Support style presets and per-cue edits.
- [x] `5.5.d` Import/export SRT and VTT without losing supported timing/text.
- [x] `5.5.e` Compile burned-in/embedded captions with capability warnings.
- [x] `5.5.f` Add multilingual/RTL, overlap, Unicode, and round-trip tests.

### 5.6 Transcript editing

- `5.6.a` Propose filler-word, silence, retake, and duplicate-removal candidates.
- `5.6.b` Return evidence, confidence, and previewable ranges without auto-applying.
- `5.6.c` Normalize approved ranges and apply one batched ripple mutation.
- `5.6.d` Preserve linked clips, sync locks, captions, markers, and undo semantics.
- `5.6.e` Add false-positive, boundary, overlap, and complete-undo tests.

Milestone 5 exit: CPU-only local analysis can transcribe, inspect, search, caption,
and propose reviewed transcript edits with cached, source/timeline-mapped results.

## Milestone 6 — Kdenlive interoperability and editing knowledge

**Status: implemented in the public preview. Kdenlive 26.04.x is the supported interchange target.**

### 6.1 OTIO export/import

- `6.1.a` Define the supported OTIO feature/fidelity matrix.
- `6.1.b` Export tracks, clips, trims, transitions, markers, and metadata.
- `6.1.c` Import supported OTIO objects into a new canonical revision.
- `6.1.d` Preserve stable IDs through namespaced metadata where possible.
- `6.1.e` Report unsupported schemas/effects and fidelity loss.
- `6.1.f` Add OTIO round-trip and external-tool fixture tests.

### 6.2 Kdenlive project export

- `6.2.a` Document supported Kdenlive/MLT project-version matrix.
- `6.2.b` Generate Kdenlive-readable profile, bin, timeline, and folder metadata.
- `6.2.c` Map supported effects, transitions, titles, captions, and markers.
- `6.2.d` Preserve stable IDs in metadata without making Kdenlive authoritative.
- `6.2.e` Open and render exported fixtures in supported Kdenlive versions.
- `6.2.f` Return explicit export fidelity warnings.

### 6.3 Re-import policy

- `6.3.a` Detect Kdenlive/OTIO version, provenance, and project identity.
- `6.3.b` Parse supported common-subset edits into an import plan.
- `6.3.c` Diff the import plan against the canonical revision for review.
- `6.3.d` Apply approved import as one new revision with checkpoint/undo.
- `6.3.e` Reject ambiguous destructive mappings; warn on unsupported data.
- `6.3.f` Add external edit, deleted media, ID loss, and unsupported-effect tests.

### 6.4 Editing recipe resources

- `6.4.a` Define recipe schema, prerequisites, safety notes, and tool-call examples.
- `6.4.b` Add rough cut, dialogue cleanup, silence/filler, and pacing recipes.
- `6.4.c` Add J/L cut, b-roll, transition, and continuity recipes.
- `6.4.d` Add music ducking, captions, lower third, and color-continuity recipes.
- `6.4.e` Add YouTube long-form, Shorts, chapters, and delivery recipes.
- `6.4.f` Validate examples against MCP schemas and fixture projects in CI.

### 6.5 Timeline diagnostics

- `6.5.a` Define diagnostic output, severity, evidence, and configurable thresholds.
- `6.5.b` Detect pacing outliers, excessive silence, and likely jump cuts.
- `6.5.c` Detect unsafe text placement and missing/overfast captions.
- `6.5.d` Detect dialogue/music balance, clipping, and continuity concerns.
- `6.5.e` Detect export/profile/media mismatches before rendering.
- `6.5.f` Add explainable fixture expectations and false-positive controls.

Milestone 6 exit: the documented common subset round-trips through OTIO/Kdenlive
with explicit fidelity reports, and recipes/diagnostics are schema-tested.

## Milestone 7 — Public release

Public-preview implementation and acceptance evidence are tracked in
[`milestone-7.md`](milestone-7.md). Tasks that require deferred Milestones 5/6 or
redistributing unaudited runtime binaries remain explicitly unchecked.

### 7.1 Windows and Linux packaging

- `7.1.a` Define supported OS/architecture matrix and pinned runtime manifest.
- `7.1.b` Bundle pinned Node, MLT, FFmpeg, plugins, fonts, and worker runtime.
- `7.1.c` Configure relocatable paths and isolated environment variables.
- `7.1.d` Add first-run capability/self-test and actionable failure reporting.
- `7.1.e` Build archives/installers in clean, reproducible CI environments.
- `7.1.f` Test install, upgrade, uninstall, Unicode paths, and offline operation.

### 7.2 Installation and MCP configuration

- `7.2.a` Add one-command install and verification for Windows.
- `7.2.b` Add one-command install and verification for Linux.
- `7.2.c` Provide verified Codex and Claude configuration examples.
- `7.2.d` Provide verified Cursor and generic MCP client examples.
- `7.2.e` Document allowed roots, tokens, logs, updates, and uninstall.
- `7.2.f` Test instructions from clean machines/accounts.

### 7.3 Documentation

- `7.3.a` Publish architecture, data ownership, and threat model.
- `7.3.b` Publish project schema, migrations, and compatibility guarantees.
- `7.3.c` Generate tool/resource/error reference from schemas.
- `7.3.d` Publish tutorials, examples, troubleshooting, and runtime matrix.
- `7.3.e` Publish contribution, release, security, and support policies.
- `7.3.f` Add link, command, example-schema, and documentation build checks.

### 7.4 Supply chain and license audit

- `7.4.a` Generate CycloneDX/SPDX SBOMs for source and each binary bundle.
- `7.4.b` Generate exact dependency/runtime notices and corresponding-source package.
- `7.4.c` Record MLT modules, FFmpeg configure flags, codecs, fonts, and models.
- `7.4.d` Add vulnerability, secret, dependency, and binary provenance scans.
- `7.4.e` Sign artifacts/provenance and publish checksums.
- `7.4.f` Verify reproducibility and complete legal/security release review.

### 7.5 End-to-end release candidate

- `7.5.a` Publish redistributable mixed-media source fixtures and expected hashes.
- `7.5.b` Run ingest, transcription, search, rough-cut, and transcript-edit workflow.
- `7.5.c` Add b-roll, J/L cuts, transitions, titles, captions, ducking, and motion.
- `7.5.d` Run previews/diagnostics and export/re-import through Kdenlive.
- `7.5.e` Render/verify 1080p YouTube and vertical Short outputs.
- `7.5.f` Restart mid-workflow and prove revisions, jobs, caches, and undo survive.
- `7.5.g` Publish project, history, captions, reports, interoperability files, and outputs.

Milestone 7 exit: signed Windows/Linux release artifacts reproduce the complete
reference workflow from clean installations, with SBOMs, notices, checksums,
documentation, and verified client configurations.

## Definition of done for every leaf task

- Scope and observable behavior match its task ID.
- Public/input data has a versioned schema and bounded validation where applicable.
- Unit/integration tests cover success, relevant failure, and platform behavior.
- Formatting, lint, type checks, tests, and `git diff --check` pass.
- Documentation, compatibility notes, and third-party notices are updated.
- No unrelated milestone behavior is introduced prematurely.
