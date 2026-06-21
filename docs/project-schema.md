# Canonical project schema

`project.json` is the portable source of truth. `state.sqlite` contains revision
snapshots, checkpoints, undo metadata, and probe caches used to recover and
operate on that file. Generated MLT or Kdenlive XML is never canonical state.

## Compatibility

- Current `schemaVersion`: `2`.
- Loaders migrate known older versions before validation.
- Unknown future versions are rejected; they are never interpreted as current.
- Serialization validates the model, sorts object keys recursively, preserves
  semantically ordered arrays, uses two-space JSON, and ends with one newline.

## Timing and identity

- All public project and timeline positions are nonnegative integer frames.
- FPS and speed are reduced positive rationals `{ numerator, denominator }`.
- Source ranges are half-open: `sourceIn` is included and `sourceOut` is excluded.
- Clip output duration is `ceil((sourceOut - sourceIn) / speed)` frames.
- Every project entity uses a persisted UUID. IDs are never array indexes.

## Top-level entities

| Field         | Meaning                                                                 |
| ------------- | ----------------------------------------------------------------------- |
| `settings`    | Fixed FPS, dimensions, sample rate, color metadata, and export defaults |
| `assets`      | Hashed external/managed media references and normalized probe metadata  |
| `tracks`      | Ordered video/audio tracks containing ordered clip arrays               |
| `transitions` | Track-local transitions referencing adjacent clips                      |
| `texts`       | Styled title/lower-third overlays with normalized canvas geometry       |
| `captions`    | Styled frame ranges independent of media tracks                         |
| `markers`     | Frame markers, chapters, and comments                                   |

The executable Zod definitions in `packages/project-core/src/schema.ts` are
authoritative. Semantic rules—including references, track compatibility,
overlaps, source bounds, runtime capabilities, and media availability—are applied
by `validateProject` and before every store commit.

Clips include transform, crop, opacity, audio properties, ordered effects, and
clip-local property/effect keyframes. Keyframes support `linear`, `hold`, and
`smooth` interpolation and must fall inside the current clip duration. Structural
edits transform those local frame coordinates when trims, splits, or speed change.

## Persistence and revisions

Every mutation supplies `expectedRevision` and an assistant identity. A successful
commit increments the revision once and returns changed IDs, warnings, and an undo
token. A stale revision fails without writing. Undo/redo refuses to overwrite
intervening changes, and project-file recovery uses the current SQLite revision
snapshot if a crash leaves the portable JSON stale or malformed.

## Media paths

- External assets store normalized absolute paths and must originate inside an
  allowed import root.
- Managed assets store forward-slash paths relative to the project directory.
- Ingest resolves symlinks before root-containment checks, hashes files while
  streaming, detects duplicates by SHA-256, and invokes ffprobe without a shell.
