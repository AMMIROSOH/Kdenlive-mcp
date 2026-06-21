# Contributing

## Development checks

Use Node.js 22+, pnpm 9, and Python 3.12. Before opening a pull request, run:

```shell
pnpm install --frozen-lockfile
pnpm check
python -m pip install -e "apps/analysis-worker[dev]"
python -m ruff check apps/analysis-worker
pnpm worker:check
```

Runtime changes also require `pnpm capabilities`; rendering changes require the
spike smoke test documented in `docs/milestone-0.md`.

## Changes and releases

Commits use Conventional Commits (`feat:`, `fix:`, `docs:`, `test:`, `build:`,
`ci:`, `chore:`). Keep a commit focused on one roadmap subtask and include its ID
in the body when useful. Release Please converts conventional commits into the
changelog and release pull request.

Pull requests must state the validation performed and call out changes to project
semantics, external commands, licenses, or platform behavior.
