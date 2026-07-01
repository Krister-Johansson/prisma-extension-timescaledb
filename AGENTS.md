# Working in this repository (agents & humans)

This repo follows the shared setup from
[Krister-Johansson/shared-configs](https://github.com/Krister-Johansson/shared-configs).
These rules are binding for AI agents working here; CONTRIBUTING.md is the
human-facing version.

> **Also read [CLAUDE.md](CLAUDE.md)** — it holds the TimescaleDB/Prisma-specific
> constraints (idempotent DDL, reset-safety, DMMF isolation, ...). Nothing below
> overrides it.

## Workflow rules

### 1. Issue-first — no code without an issue

Every piece of work starts as a GitHub issue describing the problem or feature.
If none exists, create one before touching code:

```sh
gh issue create --title "<imperative summary>" --body "<problem, expected behavior, context>"
```

Every pull request MUST reference its issue with `Closes #<number>` in the PR
description. The CI job `linked issue` fails PRs that don't.

### 2. Test-driven development (TDD)

1. Write the test first — unit (`test/unit`), type-level (`test/types`), or
   integration (`test/integration`, Testcontainers), whichever fits the change.
2. Run it and **confirm it fails** for the expected reason.
3. Implement the minimal change that makes it pass.
4. Refactor with the tests green.

New functionality and bug fixes without accompanying tests are rejected in
review. Any change to emitted migration SQL must come with an integration test
proving reset-safety (see CLAUDE.md).

### 3. Conventional Commits

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/)
(`feat:`, `fix:`, `docs:`, `chore:`, `test:`, `refactor:`; `!`/`BREAKING CHANGE:` for
majors). They drive automated releases via release-please — a wrong type means a
wrong version bump.

### 4. Branch and verify

- Branch from `main`; one issue per branch/PR.
- Before pushing, run the local CI equivalent:
  `npm run build && npm run typecheck && npm run coverage && npm run test:types && npm run attw`
  (integration tests need Docker: `npm run test:integration`).
- All changes land through PRs — `main` is protected; CI must be green.

## Release model (do not do these manually)

- Versions, tags, CHANGELOG.md, and GitHub releases are managed by release-please.
  Never bump `version` in package.json or edit CHANGELOG.md by hand.
- npm publishing happens in CI after the release PR merges.
