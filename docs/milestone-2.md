# Milestone 2: timeline editing engine

Milestone 2 is implemented in `packages/project-core`. Editing functions operate
on canonical project values, return changed IDs and warnings, validate the result,
and can be committed through `commitEdit` for revision checks and undo/redo.
Schema version 2 adds text overlays, crop state, and property keyframes; version 1
projects migrate explicitly on load.

## 2.1 Timeline query model

- [x] Return compact project, FPS, dimensions, duration, track, and clip state.
- [x] Filter by frame range, track IDs, entity/asset IDs, and effect detail.
- [x] Return linkage, source/timeline ranges, transitions, text, captions, and markers.
- [x] Enforce stable ordering, bounded pagination, and response size controls.

## 2.2 Placement operations

- [x] Create compatible video/audio tracks with stable UUIDs.
- [x] Append and explicitly position batched clips.
- [x] Overwrite with deterministic head/tail splitting.
- [x] Insert with crossing-clip splitting and sync-locked track movement.
- [x] Reject collisions when overwrite was not requested.
- [x] Place reciprocal linked video/audio clips for AV assets.

## 2.3 Structural edits

- [x] Move and remove clips with linked-clip closure and locked-track checks.
- [x] Split clips and propagate trims, effects, keyframes, and links.
- [x] Trim, slip, and change speed with source/collision validation.
- [x] Transform property/effect keyframes through trim, split, and speed changes.
- [x] Normalize and apply batched ripple ranges to clips and timed entities.
- [x] Respect sync-locked tracks and remove invalid transitions/link references.

## 2.4 Properties and animation

- [x] Set batched transform, crop, opacity, volume, pan, and mute properties.
- [x] Add linear, hold, and smooth clip-local keyframes.
- [x] Validate animatable property names, duplicate frames, and clip bounds.
- [x] Preserve deterministic ordering and changed-ID reporting.

## 2.5 Effects and transitions

- [x] Build a versioned catalog from discovered MLT filters/transitions.
- [x] Include typed definitions for known properties and documented raw properties.
- [x] Replace ordered clip effect stacks with enable/bypass and keyed parameters.
- [x] Add/remove transitions with track, adjacency, timing, and capability validation.

Unknown MLT services intentionally expose an empty typed parameter list and
`rawPropertiesAllowed: true`; the caller must use probed service names, and the
project validator reports unavailable services.

## 2.6 Text, captions, and markers

- [x] Add/update/remove styled title and lower-third overlays.
- [x] Diagnose title-safe area violations.
- [x] Add/update/remove captions and validate cue ranges/overlaps.
- [x] Import/export SRT and WebVTT using project-frame timing.
- [x] Add/update/remove markers, comments, and chapters.
- [x] Export YouTube chapter text with a required frame-zero chapter.

## Acceptance

```shell
pnpm check
pnpm test:coverage
```

The suite covers every editing gesture, atomic store integration and undo, linked
media, collision behavior, keyframes, creative entities, caption round trips, and
40 generated append-placement scenarios per run. Rendering these canonical edits
is Milestone 3; Milestone 2 does not compile MLT XML.
