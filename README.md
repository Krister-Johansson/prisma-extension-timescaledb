# prisma-extension-timescaledb

Type-safe [TimescaleDB](https://www.tigerdata.com/) / TigerData time-series support for
Prisma: **reset-safe migrations**, hypertables, continuous aggregates, and typed query
helpers.

Prisma can't express TimescaleDB features in its schema language, and the naive setup
breaks on `prisma migrate reset` / `migrate dev`. This package fills the gap with two
cooperating parts:

1. A **Prisma generator** that reads `///` annotations and emits reset-safe migration SQL
   plus a typed runtime registry.
2. A **Prisma Client extension** that exposes fully-typed `timeBucket(...)` queries and a
   `$timescale` management namespace.

> **v0.1 is time-series only:** hypertables + continuous aggregates + reset-safe migrations
> + typed query helpers. Vector search, BM25, hypercore/columnstore, and retention are out
> of scope for v0.1.

## Requirements

- **Prisma 7** (`prisma` and `@prisma/client` `>=7.0.0`). This release targets Prisma 7
  only (it relies on the v7 `prisma.config.ts` + `prisma-client` generator model).
- A **TimescaleDB-capable PostgreSQL** for both your database and the Prisma shadow
  database (see [Shadow database](#shadow-database)).
- A Prisma [driver adapter](https://www.prisma.io/docs/orm/overview/databases) for the
  client at runtime (e.g. `@prisma/adapter-pg`).

## Install

```bash
npm install prisma-extension-timescaledb
npm install -D prisma @prisma/client
```

## Setup

### 1. Configure the generator and shadow database

`schema.prisma`:

```prisma
generator client {
  provider        = "prisma-client"
  output          = "./client"
  previewFeatures = ["views"]
}

// Emits reset-safe migrations + the typed registry consumed by the client extension.
generator timescaledb {
  provider = "prisma-extension-timescaledb"
  output   = "./timescale"
}

datasource db {
  provider = "postgresql"
}
```

`prisma.config.ts` (Prisma 7 moves connection settings here):

```ts
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "schema.prisma",
  migrations: { path: "migrations" },
  datasource: {
    url: process.env["DATABASE_URL"],
    // Must point at a TimescaleDB-capable database — see "Shadow database" below.
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
```

### 2. Annotate your schema

```prisma
/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
}

/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time", refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" })
view SensorHourly {
  bucket   DateTime /// @timescale.bucket
  deviceId Int      /// @timescale.groupBy
  avgTemp  Float    /// @timescale.aggregate(fn: "avg", column: "temperature")
  maxTemp  Float    /// @timescale.aggregate(fn: "max", column: "temperature")

  // Prisma 7 disallows @@id on views — use @@unique for the identifier.
  @@unique([deviceId, bucket])
}
```

### 3. Generate, then migrate

```bash
# 1. Create your normal table migration (Prisma's CREATE TABLE):
npx prisma migrate dev --create-only --name init

# 2. Run the generator — it writes the extension + hypertable/cagg migrations and the registry:
npx prisma generate

# 3. Apply everything:
npx prisma migrate deploy
```

The generator writes two fixed-name migrations that bracket your own:

- `00000000000000_timescaledb_extension/` — `CREATE EXTENSION IF NOT EXISTS timescaledb`
  (sorts **first**, runs before any table DDL).
- `99999999999999_timescaledb_objects/` — the hypertable conversions and continuous
  aggregates (sorts **last**, after Prisma's `CREATE TABLE`s).

All emitted SQL is idempotent, so `prisma migrate reset` replays it cleanly. **Always run
`prisma generate` before applying migrations** so the generated SQL reflects your current
annotations.

## Runtime usage

```ts
import { PrismaClient } from "./client/client.js";
import { PrismaPg } from "@prisma/adapter-pg";
import { timescaledb } from "prisma-extension-timescaledb";
import { registry } from "./timescale/index.js";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL });
const prisma = new PrismaClient({ adapter }).$extends(timescaledb(registry));
```

### Ad-hoc `time_bucket` queries

```ts
const rows = await prisma.sensorReading.timeBucket({
  bucket: "1 hour",
  range: { start, end },          // both bounds required
  where: { deviceId: 1 },         // top-level equality (v0.1)
  groupBy: ["deviceId"],
  aggregate: {
    avgTemp: { avg: "temperature" },
    maxTemp: { max: "temperature" },
  },
});
// rows: Array<{ bucket: Date; deviceId: number; avgTemp: number; maxTemp: number }>
```

Aggregate columns are validated against the model's scalar fields at **compile time**, and
the result row type is inferred from `groupBy` + `aggregate`.

### Reading a continuous aggregate

A continuous aggregate is a Prisma `view`, so reads are ordinary, fully-typed Prisma:

```ts
const hourly = await prisma.sensorHourly.findMany({
  where: { bucket: { gte: start }, deviceId: 1 },
  orderBy: { bucket: "desc" },
});
```

### Management

```ts
// Refresh a continuous aggregate (open bounds = full refresh).
await prisma.$timescale.refreshContinuousAggregate("SensorHourly");
await prisma.$timescale.refreshContinuousAggregate("SensorHourly", { start, end });
```

## Without the generator (manual config)

The client extension works **without** the generator — pass the config directly, so a Prisma
internal-API change can never fully break you:

```ts
const prisma = new PrismaClient({ adapter }).$extends(
  timescaledb({
    hypertables: [{ table: "SensorReading", column: "time", chunkInterval: "1 day" }],
  }),
);
```

The SQL builders are also exported from `prisma-extension-timescaledb/core` for use in
hand-written migrations (`createExtensionSql`, `createHypertableSql`,
`createContinuousAggregateSql`).

## Shadow database

Prisma's `migrate dev` / `migrate reset` validate migrations against a temporary **shadow
database**. Because the first migration runs `CREATE EXTENSION timescaledb`, the shadow
database must live on a **TimescaleDB-capable server**. Set `shadowDatabaseUrl` to a
dedicated database on the same image.

**Tiger Cloud caveat (honest limitation):** Tiger Cloud rejects Prisma's auto-created shadow
database name, so a dedicated `shadowDatabaseUrl` is **mandatory** there — this package
cannot fully paper over that restriction.

## Annotation reference

| Annotation | On | Arguments |
| --- | --- | --- |
| `@timescale.hypertable` | model | `column` (required), `chunkInterval` (default `"7 days"`) |
| `@timescale.continuousAggregate` | view | `source`, `bucket`, `timeColumn` (required); `refresh: { startOffset, endOffset, scheduleInterval }` (optional) |
| `@timescale.bucket` | view field | — (exactly one per cagg) |
| `@timescale.groupBy` | view field | — |
| `@timescale.aggregate` | view field | `fn` (`avg`\|`sum`\|`min`\|`max`\|`count`), `column` |

Intervals are `"<amount> <unit>"` where unit is `second(s)`, `minute(s)`, `hour(s)`,
`day(s)`, `week(s)`, or `month(s)` — validated at compile time.

## v0.1 limitations

- **`where` in `timeBucket`** supports top-level equality only at runtime (it throws on
  operators / nested filters), though it is typed with Prisma's full where input.
- **Table name must equal the model name** — `@@map` is not yet handled.
- **Integer-column aggregates**: `count` is returned as a JS `number`; `sum`/`avg` over
  integer columns may return a Postgres `bigint`/`numeric` while typed as `number`. Float
  columns behave as expected.
- Continuous aggregates must be declared as Prisma `view`s with `@@unique` (not `@@id`).

## License

MIT © Krister Johansson
