# Milestone 7: public preview release

Milestone 7 prepares the implemented editor/MCP core for public use. Milestones 5
and 6 are explicitly deferred, so the release candidate does not claim local AI
analysis, semantic search, OTIO, or Kdenlive project round trips.

## 7.1 Packaging

- [x] Define the Windows/Linux x64 support matrix and machine-readable runtime manifest.
- [x] Package the built MCP application and production Node dependencies.
- [x] Auto-discover external Kdenlive/MLT/FFmpeg installations and support exact overrides.
- [x] Add `--doctor` with actionable executable/service/codec checks.
- [x] Produce Windows ZIP and Linux tar.gz archives with content manifests/checksums.
- [x] Add source installers, repeatable upgrades, uninstallers, Unicode-path-safe operations, and offline runtime operation.
- [ ] Bundle Node/Kdenlive/MLT/FFmpeg binaries. Deferred until exact runtime license/source and binary provenance audits are complete.

## 7.2 Installation and MCP configuration

- [x] Provide one-command Windows and Linux source installation.
- [x] Document automatic discovery, portable overrides, state, tokens, logs, upgrades, and uninstall.
- [x] Provide Codex, Claude Desktop, Cursor, and generic stdio examples.
- [x] Verify protocol behavior with official MCP SDK stdio and Streamable HTTP clients.

Codex documentation was unreachable during final documentation verification. The
included TOML uses the established `mcp_servers` configuration surface, but users
should confirm the config-file location for their installed Codex version.

## 7.3 Public documentation

- [x] Publish architecture/data ownership, schema, migration, and compatibility documentation.
- [x] Publish the MCP tool/resource/error reference.
- [x] Publish installation, tutorial, troubleshooting, runtime, contribution, security, support, and release guides.
- [x] Validate required documents and local Markdown links in CI.

## 7.4 Supply chain

- [x] Generate CycloneDX 1.5 and SPDX 2.3 application SBOMs.
- [x] Retain third-party notices and exact external-runtime policy.
- [x] Add dependency review, CodeQL, secret scan, content manifests, and SHA-256 checksums.
- [x] Add keyless Sigstore blob signing and GitHub artifact attestations for published releases.
- [ ] Complete independent legal/security audits. These require human reviewers and cannot be asserted by automation.

## 7.5 Release acceptance

- [x] Regenerate synthetic redistributable A/V fixtures.
- [x] Run ingest, linked A/V placement, titles/captions/effects/transitions, previews, exports, restart recovery, and verification through the implemented core/MCP layers.
- [x] Retain acceptance reports and preview/output artifacts locally and in CI.
- [ ] Transcription/search/transcript editing and OTIO/Kdenlive round trips are deferred with Milestones 5 and 6.

## Acceptance

```shell
pnpm check
pnpm docs:check
pnpm doctor
pnpm render:acceptance
pnpm mcp:acceptance
pnpm sbom
pnpm package:release -- --platform windows
pnpm release:acceptance -- --platform windows
```

The first public release is intentionally an external-runtime public preview. It
is suitable for local testing and contribution, not a claim of production
hardening or independent audit.
