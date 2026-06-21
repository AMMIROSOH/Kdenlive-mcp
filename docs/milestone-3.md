# Milestone 3: rendering and inspection

Milestone 3 is implemented in `packages/render-core`. It compiles canonical
schema-v2 projects to deterministic MLT XML, persists render jobs in SQLite,
produces bounded cached previews, exposes validated export profiles, and verifies
rendered media with ffprobe and FFmpeg.

## 3.1 MLT compiler

- [x] Compile deterministic profiles, producers, playlists, physical layers, and tractors.
- [x] Compile trims, speed, transform, crop, opacity, volume, pan, effects, and keyframes.
- [x] Extend clips into transition windows when source handles are available and warn otherwise.
- [x] Compile text, captions, markers, linkage-aware audio mixing, and video compositing.
- [x] Validate projects and optional runtime capabilities before compilation.
- [x] Lock compiler output with a golden SHA-256 test.

The compiler keeps one physical MLT layer per clip so canonical overlapping
tracks and transitions remain unambiguous. Transition handle extension currently
requires normal-speed clips; changed-speed transitions return
`TRANSITION_SPEED_HANDLE_FIDELITY` instead of silently changing timing.

## 3.2 Render job manager

- [x] Persist queued/running/succeeded/failed/cancelled jobs and progress in SQLite.
- [x] Run bounded concurrent jobs without a shell and parse MLT progress output.
- [x] Keep bounded per-job logs and isolated temporary workspaces.
- [x] Cancel running process trees, retry failed work, and clean abandoned temporary files.
- [x] Recover interrupted running jobs to the queue after restart.

## 3.3 Preview pipeline

- [x] Render exact composited frames.
- [x] Render labeled contact sheets.
- [x] Render bounded low-resolution A/V ranges and audio-only ranges.
- [x] Render waveform images.
- [x] Cache artifacts by canonical project fingerprint, request, and compiler options.
- [x] Enforce frame-count limits for range previews.

## 3.4 Export profiles

- [x] Validate versioned profiles without accepting raw command fragments.
- [x] Provide YouTube 1080p, 1440p, and 4K profiles.
- [x] Provide vertical Shorts, FFV1 mezzanine, WAV, SRT, and WebVTT profiles.
- [x] Check required codecs against runtime capabilities with explicit failures.
- [x] Publish a serializable profile catalog.

Caption profiles route to the deterministic SRT/WebVTT serializers in
`project-core`; they are not passed to the MLT media consumer.

## 3.5 Output verification

- [x] Verify duration, streams, codecs, dimensions, frame rate, and sample rate data.
- [x] Compare audio/video end timestamps when stream duration metadata is available.
- [x] Measure integrated loudness and maximum volume and diagnose clipping.
- [x] Detect black and frozen video segments.
- [x] Return structured error/warning diagnostics and numeric metrics.
- [x] Exercise known-good and deliberately black/frozen fixtures.

## Acceptance

```shell
pnpm check
pnpm render:acceptance
```

The acceptance run generates synthetic 30 fps FFV1/PCM media, creates two linked
A/V clips with an MLT transition, an effect, title, and caption, queues a lossless
render, verifies the output, and produces frame, range, audio, waveform, and
contact-sheet previews. It also verifies that a deliberately defective fixture
triggers black/freeze diagnostics. Results are written to
`artifacts/milestone-3-acceptance/acceptance-report.json`.

Verified locally against Kdenlive 26.04.2, MLT 7.39.0, and FFmpeg/ffprobe 8.0.1
from `C:\Program Files\Kdenlive`. Windows and Linux render jobs run the same
acceptance command in CI.

Milestone 4 can now expose these APIs through MCP. It must not bypass the existing
project validation, argument-array process execution, ownership, or artifact
limits.
