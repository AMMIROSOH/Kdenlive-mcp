# Release process

1. Run `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm docs:check`,
   `pnpm render:acceptance`, and `pnpm mcp:acceptance` on a supported runtime.
2. Run `pnpm sbom` and inspect both CycloneDX and SPDX documents.
3. Build both platform archives with `pnpm package:release -- --platform <platform>`.
4. Compare each extracted `MANIFEST.json` with a clean rebuild and verify archive checksums.
5. Review dependency licenses, runtime manifest, notices, CodeQL, dependency review,
   and secret scanning. External runtimes are not part of the archive.
6. Merge a conventional commit carrying `[release]` to let Release Please create
   the release PR/release.
7. The published-release workflow rebuilds archives, creates SBOMs/checksums,
   keylessly signs blobs with Sigstore, and uploads all assets.
8. Verify the GitHub attestations/signature bundles and test installation from the
   uploaded archives before announcing the release.

Release automation supports signing, but maintainer review is still required.
Never describe an artifact as independently audited or reproducible across archive
formats unless the clean-build comparison has actually been completed.
