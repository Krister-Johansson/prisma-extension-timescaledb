# prisma-extension-timescaledb

[![npm](https://img.shields.io/npm/v/prisma-extension-timescaledb)](https://www.npmjs.com/package/prisma-extension-timescaledb)
[![npm downloads](https://img.shields.io/npm/dm/prisma-extension-timescaledb)](https://www.npmjs.com/package/prisma-extension-timescaledb)
[![node](https://img.shields.io/node/v/prisma-extension-timescaledb)](https://www.npmjs.com/package/prisma-extension-timescaledb)
[![types](https://img.shields.io/npm/types/prisma-extension-timescaledb)](https://www.npmjs.com/package/prisma-extension-timescaledb)
![Prisma](https://img.shields.io/badge/Prisma-%3E%3D7.0.0-2D3748)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)

[![CI](https://github.com/Krister-Johansson/prisma-extension-timescaledb/actions/workflows/ci.yml/badge.svg)](https://github.com/Krister-Johansson/prisma-extension-timescaledb/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/Krister-Johansson/prisma-extension-timescaledb/branch/main/graph/badge.svg)](https://codecov.io/gh/Krister-Johansson/prisma-extension-timescaledb)
[![Socket Badge](https://socket.dev/api/badge/npm/package/prisma-extension-timescaledb)](https://socket.dev/npm/package/prisma-extension-timescaledb)
[![OpenSSF Scorecard](https://api.securityscorecards.dev/projects/github.com/Krister-Johansson/prisma-extension-timescaledb/badge)](https://scorecard.dev/viewer/?uri=github.com/Krister-Johansson/prisma-extension-timescaledb)
[![OpenSSF Best Practices](https://www.bestpractices.dev/projects/13331/badge)](https://www.bestpractices.dev/projects/13331)

Type-safe [TimescaleDB](https://www.tigerdata.com/) / TigerData time-series
support for Prisma: reset-safe migrations, hypertables, continuous aggregates,
and typed query helpers.

[Documentation](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki) ·
[npm](https://www.npmjs.com/package/prisma-extension-timescaledb) ·
[NestJS example](https://github.com/Krister-Johansson/prisma-extension-timescaledb-nestjs-example)

Prisma cannot model TimescaleDB features in its schema language, and the naive
setup breaks on `prisma migrate reset` and `migrate dev`. This package fixes
that with:

- Hypertables and continuous aggregates from `///` schema annotations
- Retention policies that drop old chunks automatically
- Columnstore compression for old chunks (TimescaleDB hypercore)
- Reset-safe migrations that survive `prisma migrate reset`, proven against a
  real TimescaleDB in CI
- Typed `timeBucket(...)` queries with result-row inference, compile-time
  column checks, gap-filling, and Toolkit hyperfunctions (percentiles,
  counters, OHLC, and more)
- A generator-optional client extension that also works from a manual config

Scope: hypertables, continuous aggregates, retention and compression,
reset-safe migrations, typed query helpers. Vector and BM25 search are out of
scope for now.

Using a different ORM? TigerData's official
[`@timescaledb/*`](https://github.com/timescale/timescaledb-ts) packages cover
TypeORM and Sequelize. This package is the Prisma counterpart.

## Documentation

Full docs live in the [wiki](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki):

- [Setup](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Setup): requirements, `prisma.config.ts`, the generate then migrate flow, shadow database
- [Hypertables](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Hypertables): chunk interval, space partitioning, chunk skipping
- [Continuous aggregates](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Continuous-Aggregates): refresh, real-time and hierarchical caggs
- [Retention and compression](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Retention-and-Compression)
- [timeBucket queries](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/timeBucket-Queries): where, relation filters, `orderBy` and `limit`, gap-filling, time zones
- [Aggregates and hyperfunctions](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Aggregates-and-Hyperfunctions): every function, exact output, Toolkit hyperfunctions
- [`$timescale` management](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Management): refresh, chunk ops, resize, background jobs
- [Annotation reference](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Annotation-Reference) · [Without the generator](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Without-the-Generator) · [Troubleshooting](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Troubleshooting)

## Install

```bash
npm install prisma-extension-timescaledb
npm install -D prisma @prisma/client
npm install @prisma/adapter-pg            # or your preferred driver adapter
```

Requires Prisma 7 and a TimescaleDB-capable PostgreSQL, for both the database
and the Prisma shadow database. Locally, the
[`timescale/timescaledb`](https://hub.docker.com/r/timescale/timescaledb)
image works. Compression needs TimescaleDB 2.18 or newer; the Toolkit
hyperfunctions need `timescaledb_toolkit` (the `timescale/timescaledb-ha`
image, or Tiger Cloud). See
[Setup](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Setup).

Releases are published from CI with npm provenance; `npm audit signatures`
verifies them. [SECURITY.md](./SECURITY.md) has the details.

## Quick start

```prisma
// schema.prisma
generator client {
  provider        = "prisma-client"
  output          = "./client"
  previewFeatures = ["views"]
}

generator timescaledb {
  provider = "prisma-extension-timescaledb"   // emits reset-safe migrations + a typed registry
  output   = "./timescale"
}

datasource db {
  provider = "postgresql"
}

/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
  @@index([time(sort: Desc)])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time", refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" })
view SensorHourly {
  bucket   DateTime /// @timescale.bucket
  deviceId Int      /// @timescale.groupBy
  avgTemp  Float    /// @timescale.aggregate(fn: "avg", column: "temperature")

  @@unique([deviceId, bucket])   // Prisma 7 disallows @@id on views
}
```

```bash
npx prisma migrate dev --create-only --name init   # your normal CREATE TABLE
npx prisma generate                                # emits the timescale migrations + registry
npx prisma migrate deploy                          # applies everything, in the right order
```

The same three steps cover later schema changes: when the annotated objects
change, `prisma generate` appends a new versioned migration
(`..._timescaledb_objects_v0002`, and so on) instead of rewriting an applied
one, and the next `migrate deploy` (or `migrate dev`) applies it. Regenerating
an unchanged schema writes nothing. The generator keeps its state in
`migrations/.prisma-extension-timescaledb.json`; commit that file with your
migrations.

Indexes on a hypertable come from your Prisma schema and nowhere else. The
generated conversion passes `create_default_indexes => FALSE`, because the
index TimescaleDB would otherwise add on the time column is invisible to
Prisma: `migrate dev` writes a `DROP INDEX` migration for it, and that
migration then breaks the next `migrate reset`. Declare the index yourself to
keep one, using the descending order time-series queries usually want:

```prisma
@@index([time(sort: Desc)])
```

```ts
import { PrismaClient } from "./client/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { timescaledb } from "prisma-extension-timescaledb";
import { registry } from "./timescale/index.js";

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL }),
}).$extends(timescaledb(registry));

const rows = await prisma.sensorReading.timeBucket({
  bucket: "1 hour",
  range: { start, end },
  groupBy: ["deviceId"],
  aggregate: { avgTemp: { avg: "temperature" } },
});
// rows: Array<{ bucket: Date; deviceId: number; avgTemp: number }>
```

The [wiki](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki)
continues with the full setup, query, and management docs.

## Examples

A runnable NestJS app with hypertables, continuous aggregates, and
`timeBucket` queries wired up end to end:
[prisma-extension-timescaledb-nestjs-example](https://github.com/Krister-Johansson/prisma-extension-timescaledb-nestjs-example).

## Search path

TimescaleDB installs into `public`, and both the generated migrations and the runtime helpers
call its functions by name. If the connection's `search_path` does not reach `public`, those
names do not resolve:

```
ERROR: function by_range(unknown, interval) does not exist
```

Two settings put you there. A datasource schema other than `public`
(`?schema=data_collection`, which is also where Prisma keeps `_prisma_migrations`) narrows the
path Prisma runs migrations under. A role default (`ALTER ROLE app SET search_path TO
data_collection`), common in a database shared by several services, narrows it for every
connection.

You do not need to configure anything for either. The generated migrations read the extension's
own schema out of `pg_extension` and put it on the search path for the statement, and the runtime
probes once per client and qualifies the function names it sends. Prisma's own queries were never
affected, because the engine schema-qualifies the relations it generates.

Adding `public` to the URL is not a workaround: `?schema=data_collection,public` moves where
Prisma looks for its migrations table, and `migrate deploy` then fails with
`Invariant violation: migration persistence is not initialized`.

## Upgrading

An upgrade never rewrites a migration you have already applied. Fixes reach a
project through the next versioned objects migration, which `prisma generate`
appends when the annotated schema changes. Two situations need a manual step.

### A first deploy that failed on `_v0001`

Earlier versions emitted unqualified TimescaleDB function calls. Prisma runs
migrations with `search_path` set to the datasource schema alone, so a project
whose tables live outside `public` could not resolve them:

```
Migration name: 99999999999999_timescaledb_objects_v0001
ERROR: function by_range(unknown, interval) does not exist
```

Nothing in that migration applied, so you can replace it. Delete the generated
files, tell Prisma the failed migration rolled back, and regenerate:

```bash
rm -rf migrations/00000000000000_timescaledb_extension
rm -rf migrations/99999999999999_timescaledb_objects_v*
rm migrations/.prisma-extension-timescaledb.json
npx prisma migrate resolve --rolled-back 99999999999999_timescaledb_objects_v0001
npx prisma generate
npx prisma migrate deploy
```

### A `DROP INDEX` migration in your history

Earlier versions let `create_hypertable` add its own index on the time column.
Prisma does not know that index, so `migrate dev` wrote a migration to drop it:

```sql
-- DropIndex
DROP INDEX "SensorReading_time_idx";
```

That migration carries a real timestamp, so it sorts before the objects
migration that created the index. Every fresh database now fails on it, which
covers CI, a new developer's machine, `migrate reset`, and provisioning a new
production database:

```
Applying migration `20260601120000_drift`
ERROR: index "SensorReading_time_idx" does not exist
```

Databases you already deployed to keep working, because the drop ran there
while the index still existed.

To repair the history, edit that migration to drop conditionally:

```sql
-- DropIndex
DROP INDEX IF EXISTS "SensorReading_time_idx";
```

Then declare the index on the model, matching the descending order TimescaleDB
used, so Prisma stops treating it as drift:

```prisma
@@index([time(sort: Desc)])
```

Prisma asks for a reset at this point, because you edited a migration it had
already applied. `prisma migrate reset` followed by `prisma migrate deploy`
reproduces the hypertable and the index, and `migrate dev` writes an empty
migration from then on.

## Shadow database

`prisma migrate dev` and `migrate reset` validate migrations against a
temporary shadow database, and the first migration runs
`CREATE EXTENSION timescaledb`. Set `shadowDatabaseUrl` in `prisma.config.ts`
to a TimescaleDB-capable database, not Prisma's default auto-created one:

```ts
// prisma.config.ts
export default defineConfig({
  datasource: {
    url: process.env["DATABASE_URL"],
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"], // a TimescaleDB-capable DB
  },
});
```

Tiger Cloud rejects Prisma's auto-created shadow-database name, so a dedicated
`shadowDatabaseUrl` is mandatory there; this package cannot paper over it.

Turn TimescaleDB telemetry off on the shadow database once, after you create it:

```sql
ALTER DATABASE shadow SET timescaledb.telemetry_level = 'off';
```

Without it, `migrate dev` can fail intermittently with `P3016` and
`cannot drop continuous aggregate using DROP VIEW` when the schema declares a
continuous aggregate. Prisma resets the shadow with `DROP SCHEMA "public"
CASCADE` before each use, which also drops the extension when it lives in
`public`. Re-creating the extension restarts TimescaleDB's telemetry job, which
holds locks on the extension catalog while it builds its report; a reset that
arrives in that window deadlocks, Prisma silently falls back to a per-view
`DROP VIEW`, and that fails on the aggregate. With telemetry off the job takes
no locks. Dropping the aggregates from the shadow yourself before `migrate dev`
does not cover this, because the migrations re-create them inside the command
and the later resets of the same command still see them. In CI you can set it
for the whole server instead with `-c timescaledb.telemetry_level=off`.
Full details in
[Setup → Shadow database](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Setup#shadow-database).

## License

MIT © Krister Johansson
