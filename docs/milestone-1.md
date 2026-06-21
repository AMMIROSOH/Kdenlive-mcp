# Milestone 1: project and media foundation

## 1.1 Versioned project schema

- [x] Define project/entity Zod schemas, strict TypeScript types, and stable UUIDs.
- [x] Add deterministic JSON serialization and future-version rejection.
- [x] Add migration registry behavior with a version-0 fixture migration.
- [x] Add rational frame/time conversion and boundary tests.
- [x] Document schema ownership, timing, identity, and compatibility.

## 1.2 Transaction and revision store

- [x] Add SQLite revisions, metadata, checkpoints, undo history, and probe cache.
- [x] Add atomic portable JSON replacement and snapshot recovery on reopen.
- [x] Add optimistic `expectedRevision` checks and structured conflicts.
- [x] Return revision, changed IDs, warnings, and undo token for mutations.
- [x] Add assistant-scoped, conflict-safe undo/redo and checkpoint restore.
- [x] Reject structurally or semantically invalid mutations before commit.
- [ ] Run fault-injection acceptance on full disk and forced process termination.

## 1.3 Media ingest

- [x] Enforce allowed roots after realpath/symlink resolution.
- [x] Discover bounded directories with stable ordering and media filtering.
- [x] Stream SHA-256, detect duplicates, and support external/managed paths.
- [x] Invoke ffprobe without a shell and normalize video/audio/VFR/rotation/color metadata.
- [x] Cache probes by media hash and probe version.
- [x] Test duplicates, root escape, normalization, and Unicode-safe Node paths.
- [x] Run real ffprobe acceptance using the installed Windows Kdenlive runtime.

## 1.4 Project validator

- [x] Return stable diagnostic codes, severity, entity path/ID, relations, and hints.
- [x] Validate schema, IDs, references, trims, source bounds, track placement, and overlaps.
- [x] Validate linked clips, transition adjacency, captions, effects, and codecs.
- [x] Validate missing managed/external media and managed path/symlink escape.
- [x] Support changed-ID filtering and deterministic ordering.

## 1.5 Fixture library

- [x] Generate deterministic image, PCM audio, corrupt media, valid, missing, and malformed fixtures.
- [x] Define optional deterministic video and VFR generation through FFmpeg.
- [x] Record fixture checksums, provenance, and license in a manifest.
- [x] Keep generated media under ignored `artifacts/` rather than Git.
- [x] Regenerate video/VFR fixtures with the installed Windows Kdenlive FFmpeg runtime.

## Commands

```shell
pnpm check
pnpm fixtures:milestone-1
pnpm fixtures:milestone-1 -- --require-runtime
```

## Exit criterion

Milestone 1 closes after fault-injection and the same runtime suite pass on Linux.
Windows acceptance passed with Kdenlive 26.04.2, FFmpeg 8.0.1, ffprobe 8.0.1,
and MLT 7.39.0 from `C:\Program Files\Kdenlive\bin`.
