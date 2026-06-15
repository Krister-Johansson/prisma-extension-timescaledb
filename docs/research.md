# docs/research.md — background & references

Condensed background for the build. The actionable rules are already in `CLAUDE.md` and
`SPEC.md`; this captures *why* and points to primary sources.

## Why the reset problem happens

`prisma migrate reset` drops the whole database (including the `timescaledb` extension and
all hypertables), recreates it empty, then replays migration files in order. So anything
set up *outside* a migration (manually, or pre-installed by the image) is gone and never
recreated. Putting it in migrations exposes two further failure modes:

- **Ordering race:** on images where TimescaleDB is preloaded, the extension/​function
  availability and the `create_hypertable()` call can collide if batched together — hence
  the isolated, leading extension migration.
- **Shadow database clash:** `migrate dev`/`reset` validate against a temporary shadow DB.
  TimescaleDB loads as a session-level library, producing `extension "timescaledb" has
  already been loaded with another version`. On Tiger Cloud the auto-created shadow DB
  name is rejected outright. Fix: a dedicated, TimescaleDB-capable `shadowDatabaseUrl`.

## The exact cast gotcha

`create_hypertable('song_time'::regclass, 'time'::name)` fails in Prisma's migration
engine (`function create_hypertable(regclass, name) does not exist`) although it works in
raw psql. Pass the relation as a quoted string literal and use the `by_range(...)`
dimension builder instead.

## Primary sources

- TigerData forum, "Prisma migration fails" (May 2025) — the exact symptom this package
  fixes: https://forum.tigerdata.com/forum/t/prisma-migration-fails/3193
- prisma/prisma #8325 — `migrate dev`/`reset` + `extension already loaded with another
  version`, confirmed bug: https://github.com/prisma/prisma/issues/8325
- prisma/prisma #10388 / discussion #10377 — the `::regclass`/`::name` cast failure:
  https://github.com/prisma/prisma/issues/10388
- prisma/prisma #3228 — long-standing TimescaleDB support request (context for why we
  generate SQL rather than expecting schema-native support).
- prisma/prisma #25135 — introspection chokes on `_timescaledb_internal` chunk tables
  (reason to avoid letting `migrate dev` introspect Tiger internals).

## Prisma extensibility facts that shape the design

- **DMMF / `@prisma/generator-helper` is internal and non-SemVer.** Isolate it; keep the
  runtime extension usable without the generator.
- **TypedSQL** (`$queryRawTyped`, `.sql` files, `previewFeatures = ["typedSql"]`) infers
  result types by introspecting a *live* DB at generate time — so CI needs a real
  TimescaleDB. It can express `time_bucket()` fine as long as columns are cast to
  Prisma-understood types in the SELECT. It cannot express dynamic column sets.
- The `postgresqlExtensions` preview feature was **deprecated in Prisma 6.16.0** — do not
  rely on it to enable `timescaledb`; emit `CREATE EXTENSION` in a committed migration.
- Continuous aggregates are best surfaced as Prisma `view` models so reads are natively
  typed; they must be dropped with `DROP MATERIALIZED VIEW`.

## Prior art

- Official `timescaledb-ts` (github.com/timescale/timescaledb-ts): `@timescaledb/core` SQL
  builders + a `@timescaledb/typeorm` adapter. **No Prisma adapter. Retention unsupported.**
  Alpha (~30 stars). Good vocabulary blueprint (`@Hypertable`, `timeBucket`,
  `getCandlesticks`), not a dependency. Led by an ex-Prisma engineer (Daniel Starns).
- This package is the missing Prisma adapter for that same architecture, scoped to
  time-series first.
