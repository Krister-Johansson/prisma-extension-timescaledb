# CLAUDE.md

This file orients you (Claude Code) before you touch anything. Read it fully, then read
`SPEC.md` and `BUILD_PLAN.md`. Deep background lives in `docs/research.md`.

## What we are building

`prisma-extension-timescaledb` — a TypeScript npm package that adds **type-safe TimescaleDB / TigerData
time-series support to Prisma**. Prisma cannot express TimescaleDB features in its schema
language, so this package fills the gap with two cooperating parts:

1. A **Prisma generator** that reads `///` annotations from the schema (via the DMMF) and
   emits (a) reset-safe migration SQL and (b) typed helper code.
2. A **Prisma Client Extension** (`Prisma.defineExtension`) that exposes fully-typed
   query and management methods at runtime.

**v0.1 scope is time-series ONLY: hypertables + continuous aggregates + reset-safe
migrations + typed query helpers.** Vector search, BM25, hypercore/columnstore, and
retention are explicitly out of scope for v0.1 (retention is a documented stretch goal).
Do not build them unless `BUILD_PLAN.md` says so.

## The non-negotiable constraints (this is the whole point of the package)

These exist because the naive Prisma + TimescaleDB setup breaks on `prisma migrate reset`
and `migrate dev`. Every line of emitted SQL must obey these. If you find yourself
violating one, stop and re-read.

1. **Extension setup is its own leading migration, isolated and idempotent.**
   Emit `CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;` in a standalone migration
   that runs before any table or hypertable DDL. Never bundle `CREATE EXTENSION` in the
   same statement batch as `create_hypertable()` — that ordering race is a primary cause
   of failures.

2. **Never cast the table argument of `create_hypertable`.**
   `create_hypertable('song_time'::regclass, 'time'::name)` FAILS inside Prisma's
   migration engine with `function create_hypertable(regclass, name) does not exist`,
   even though it works in raw psql. Always pass the relation as a quoted string literal:
   `create_hypertable('"SensorReading"', by_range('time'))`.

3. **All TimescaleDB DDL must be idempotent / replay-safe.**
   Use `IF NOT EXISTS` and `if_not_exists => TRUE` on everything, because `migrate reset`
   replays migrations from scratch and a re-run must not error on "already exists".

4. **Continuous aggregates are dropped with `DROP MATERIALIZED VIEW`, never `DROP VIEW`.**
   They appear in the views catalog but `DROP VIEW` errors on them. Down-migrations must
   use `DROP MATERIALIZED VIEW IF EXISTS`.

5. **Require a TimescaleDB-capable shadow database.**
   The package's setup docs and generated README must instruct users to set
   `shadowDatabaseUrl` to a database where the `timescaledb` extension is available.
   Document the Tiger Cloud limitation honestly: Tiger Cloud rejects Prisma's
   auto-created shadow DB name, so a dedicated shadow DB is mandatory there and the
   plugin cannot fully paper over it.

6. **Hypertable conversion runs after the table is created, in its own migration step,
   and is idempotent** (`migrate_data => TRUE, if_not_exists => TRUE`).

A "reset-safe" guarantee means: a fresh DB + `prisma migrate reset` + `prisma migrate
deploy` reproduces all hypertables and continuous aggregates with zero manual steps and
zero errors. This must be covered by an integration test (see `BUILD_PLAN.md`).

## Conventions

- Language: TypeScript, `strict: true`, `module`/`moduleResolution`: `NodeNext`.
- Single package for v0.1 with internal modules `src/core`, `src/generator`,
  `src/client`. (Do not split into a monorepo yet.)
- `@prisma/client` and `prisma` are **peerDependencies** (`>=6.13`), pinned in
  devDependencies for testing. Bundle nothing from Prisma.
- Dual ESM + CJS publish via `tsup`. Validate output with `@arethetypeswrong/cli`.
- All DB-touching tests use **Testcontainers** with a TimescaleDB image. There is no way
  to test this against a mock; if Docker is unavailable, skip and say so loudly.
- Prisma's DMMF / `@prisma/generator-helper` is an **internal, non-SemVer API**. Isolate
  all DMMF access behind one module (`src/generator/dmmf.ts`) so a Prisma bump touches one
  file. The runtime extension must work **without** the generator (manual config path) so
  users are never fully broken by a Prisma upgrade.

## How to work

Work through `BUILD_PLAN.md` milestone by milestone. After each milestone, run the test
suite and stop for review before continuing. Do not jump ahead to later milestones or to
out-of-scope features. When a design decision is ambiguous, prefer the choice that makes
the reset-safety guarantee easier to test.
