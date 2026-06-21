# Milestone 0: feasibility and foundation

Each checkbox is deliberately small enough to implement or re-run in one focused
session. The identifiers preserve traceability to the roadmap.

## 0.1 Architecture and licensing ADR

- [x] 0.1.a Record editor/engine selection and ownership boundary.
- [x] 0.1.b Record distribution and dependency-license obligations.
- [x] 0.1.c Record v1 exclusions and conditions for revisiting the decision.
- [ ] 0.1.d Have release counsel review the distribution checklist before bundling binaries.

Artifacts: `docs/adr/0001-editor-engine-boundary.md`, `LICENSE`, and
`THIRD_PARTY_NOTICES.md`.

## 0.2 Repository scaffold

- [x] 0.2.a Add the pnpm/TypeScript workspace and strict compiler settings.
- [x] 0.2.b Add formatting, linting, unit tests, and package build boundaries.
- [x] 0.2.c Add the Python 3.12 worker shell and its quality gates.
- [x] 0.2.d Add issue/PR templates and contribution rules.
- [x] 0.2.e Add Windows/Linux CI and conventional release automation.

Acceptance: `pnpm install && pnpm check`; then create a Python 3.12 environment,
install `apps/analysis-worker[dev]`, and run `pnpm worker:check`.

## 0.3 Runtime capability probe

- [x] 0.3.a Resolve configured/PATH runtime executables without invoking a shell.
- [x] 0.3.b Parse runtime versions, FFmpeg codecs/filters/hardware accelerators.
- [x] 0.3.c Query MLT producers, consumers, filters, and transitions.
- [x] 0.3.d Validate and write a versioned JSON snapshot.
- [x] 0.3.e Unit-test parsing and missing-runtime behavior.
- [ ] 0.3.f Capture reference snapshots on the pinned Windows/Linux runners.

Acceptance: `pnpm capabilities -- --output artifacts/capabilities.json`. The
command exits nonzero unless all three executables are present and queryable.

## 0.4 Vertical rendering spike

- [x] 0.4.a Generate deterministic synthetic video and audio fixtures.
- [x] 0.4.b Compile two clips, audio, title, dissolve, and effect to MLT XML.
- [x] 0.4.c Render a 30-second lossless FFV1/PCM reference with one thread.
- [x] 0.4.d Validate duration, streams, dimensions, frame rate, and frame count.
- [x] 0.4.e Store golden XML and test deterministic compilation.
- [ ] 0.4.f Run smoke render on pinned MLT 7.38 Windows/Linux images.
- [ ] 0.4.g Compare normalized `framemd5` and decoded PCM hashes across platforms.

Acceptance: `pnpm spike:prepare && pnpm spike:render`. Cross-platform acceptance
is only complete when both CI smoke-render jobs pass and their decoded hashes
match. Container/runtime pinning belongs to packaging milestone 7, so CI installs
the best available MLT and reports its capability snapshot for now.

## Milestone exit criterion

The milestone closes after 0.1.d, 0.3.f, 0.4.f, and 0.4.g are evidenced. The
repository intentionally marks environment/legal checks as pending rather than
claiming they were completed by source code alone.

Local Windows evidence on 2026-06-21: Kdenlive 26.04.2, MLT 7.39.0, FFmpeg
8.0.1, and ffprobe 8.0.1 were discovered automatically under
`C:\Program Files\Kdenlive`. The 900-frame/30-second FFV1+PCM spike rendered,
validated, and produced decoded frame/audio hashes. Linux and cross-platform hash
comparison remain pending.
