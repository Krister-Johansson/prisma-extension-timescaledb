# Contributing

Thanks for your interest in improving **prisma-extension-timescaledb**! This guide covers
how to report issues, set up a dev environment, and the standards a change needs to meet.

## Reporting bugs & requesting features

- **Bugs / features:** open a [GitHub issue](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues).
  For bugs, include the Prisma version, the relevant schema annotation, and the generated SQL
  or error where possible.
- **Security vulnerabilities:** please **do not** open a public issue — follow
  [`SECURITY.md`](./SECURITY.md) (private reporting via GitHub Security Advisories).

## Development setup

Prerequisites: **Node ≥ 18.18** and **Docker** (the integration suite spins up a real
TimescaleDB via [Testcontainers](https://testcontainers.com/) — without Docker those tests
are skipped).

```bash
git clone https://github.com/Krister-Johansson/prisma-extension-timescaledb
cd prisma-extension-timescaledb
npm install
```

Useful scripts:

| Command | What it does |
| ------- | ------------ |
| `npm run build` | Bundle ESM + CJS with `tsup` |
| `npm test` | Unit tests (vitest) |
| `npm run test:types` | Type-level tests (`tsc`) |
| `npm run test:integration` | Integration tests against real TimescaleDB (needs Docker) |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run coverage` | Unit tests + coverage thresholds |
| `npm run attw` | Validate published types (`@arethetypeswrong/cli`) |

The package is a single package with internal modules: `src/core`, `src/generator`
(the Prisma generator), and `src/client` (the Client Extension).

## Coding standards

- **TypeScript, `strict: true`, `module`/`moduleResolution: NodeNext`.** Code must typecheck
  with no errors and no new warnings.
- **Match the surrounding code** — naming, comment density, and idioms. Keep changes focused.
- DMMF / `@prisma/generator-helper` access stays isolated in `src/generator/dmmf.ts`.

## Testing policy

**New functionality and bug fixes must come with tests.** Choose the level that fits:

- **Unit** (`test/unit`) for pure logic — SQL building, type inference, config parsing.
- **Type-level** (`test:types`) when the change affects the public type surface.
- **Integration** (`test/integration`) for anything that touches the database or migrations.

Any change to emitted migration SQL **must preserve reset-safety** (a fresh DB +
`prisma migrate reset` + `migrate deploy` reproduces all hypertables and continuous
aggregates with zero manual steps) and be covered by an integration test.

## Commit messages

This repo uses [Conventional Commits](https://www.conventionalcommits.org/) — `release-please`
derives versions and the changelog from them. Use `feat:`, `fix:`, `docs:`, `chore:`,
`ci:`, `refactor:`, `test:`, etc. Example: `feat(timeBucket): add gap-filling support`.

## Pull requests

1. Branch off `main`.
2. Make sure CI passes locally: `npm run build && npm run typecheck && npm test && npm run test:types && npm run attw` (and `npm run test:integration` if Docker is available).
3. Open the PR with a clear description. CI (build, unit/type tests, and the real-TimescaleDB
   integration suite) must be green before merge.

## License

By contributing, you agree that your contributions are licensed under the project's
[MIT license](./LICENSE).
