# Architecture

This page describes how prisma-extension-timescaledb is put together, for
contributors and for anyone deciding whether to trust it. For what the package
does and how to use it, see the [README](../README.md) and the
[wiki](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki).

## What it is

prisma-extension-timescaledb is a TypeScript npm package with two cooperating
parts. A Prisma generator reads `/// @timescale.*` annotations from the schema
and emits reset-safe migration SQL plus a typed registry. A Prisma Client
Extension consumes that registry at runtime and exposes typed query and
management methods. The extension also works from a manually written config,
so users are never fully broken if a Prisma upgrade breaks the generator.
Prisma itself (`prisma`, `@prisma/client`) is a peer dependency; nothing from
Prisma is bundled.

## Layout

```text
src/
  index.ts                Package root: the runtime surface users import
  core/                   Pure SQL builders, shared by generator and client
    sql.ts                Identifier/literal quoting, the one place escaping lives
    extension.ts          The CREATE EXTENSION migration
    hypertable.ts         create_hypertable and space partitioning
    continuousAggregate.ts  CREATE MATERIALIZED VIEW ... WITH (timescaledb.continuous)
    retention.ts          add_retention_policy
    compression.ts        Columnstore compression policies
    chunkSkipping.ts      enable_chunk_skipping
    interval.ts           Interval parsing and validation
    types.ts              Shared config types
  generator/              The Prisma generator (runs at `prisma generate`)
    index.ts              Entry binary; wires DMMF -> emitters
    dmmf.ts               The ONLY module that touches Prisma's DMMF
    annotations.ts        Parses /// @timescale.* annotations, fails loudly on unknowns
    emit-migrations.ts    Reset-safe migration files as a pure path -> content map
    emit-types.ts         The typed registry module
  client/                 The Prisma Client Extension (runtime)
    index.ts              defineExtension; the timeBucket model method
    timeBucket.ts         Builds the parameterized time_bucket query
    where.ts              Prisma where input -> parameterized SQL, incl. relation filters
    manage.ts             The $timescale management namespace
test/
  unit/                   vitest, pure logic
  types/                  Type-level tests (tsc)
  integration/            Testcontainers against real TimescaleDB, incl. the reset-safety proof
```

## How an annotation becomes a migration and a query

1. **Generation.** `prisma generate` spawns the generator binary. `dmmf.ts`
   extracts models, views, and their `///` annotations from the DMMF;
   `annotations.ts` parses them and rejects anything it does not recognize,
   naming the model and field in the error.
2. **Emission.** `emit-migrations.ts` produces two fixed-name migrations as a
   pure path-to-content map, with no filesystem access and no timestamps, so
   output is deterministic and snapshot-testable. The extension migration
   sorts before every Prisma migration and the objects migration sorts after
   them; within the objects migration, hypertable conversions come before
   continuous aggregates, which need their source to already be a hypertable.
   `emit-types.ts` writes the typed registry the client extension imports.
3. **Runtime.** The client extension reads the registry (or a manual config)
   and adds a `timeBucket` method per hypertable model plus the `$timescale`
   management namespace. `timeBucket.ts` and `where.ts` build one
   parameterized SQL query: identifiers are resolved through the registry and
   quoted, values are bound as `$`-parameters, and the result rows are typed
   from the aggregate spec.

## Design rules

The non-negotiable constraints live in [CLAUDE.md](../CLAUDE.md) and exist
because the naive Prisma plus TimescaleDB setup breaks on
`prisma migrate reset`:

- The `CREATE EXTENSION` migration is standalone, first, and idempotent.
- All emitted DDL is replay-safe (`IF NOT EXISTS`, `if_not_exists => TRUE`).
- Relations are passed to TimescaleDB functions as quoted string literals,
  never cast with `::regclass`, which fails inside Prisma's migration engine.
- Continuous aggregates are dropped with `DROP MATERIALIZED VIEW`.

The reset-safety guarantee (a fresh database plus `migrate reset` plus
`migrate deploy` reproduces everything with zero manual steps) is proven by an
integration test against a real TimescaleDB container, and every change to
emitted SQL must keep that test green.

Three code rules matter throughout:

- All quoting and escaping goes through `core/sql.ts`. In `timeBucket` and
  `where` queries, values are never interpolated; they are always bound as
  parameters. Management methods bind filter values as parameters too, but
  pass interval options as SQL literals that are validated first and escaped
  through `quoteLiteral`.
- Prisma's DMMF is an internal, non-SemVer API, so only `generator/dmmf.ts`
  touches it. A breaking Prisma bump lands in one file.
- TypeScript is `strict`, and explicit `any` is avoided; the one documented
  exception is the runtime-generated test client alias in the integration
  harness.

## Dependencies

One runtime dependency: `@prisma/generator-helper`, which the generator binary
needs to speak Prisma's generator protocol. `prisma` and `@prisma/client` are
peer dependencies (`>=7.0.0`). The published package ships only `dist/`, built
as dual ESM and CJS with tsup and validated with `@arethetypeswrong/cli`.
