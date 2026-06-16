# prisma-extension-timescaledb

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](./LICENSE)
![Prisma](https://img.shields.io/badge/Prisma-%3E%3D7.0.0-2D3748)

Type-safe **[TimescaleDB](https://www.tigerdata.com/) / TigerData** time-series support for
Prisma — **reset-safe migrations**, hypertables, continuous aggregates, and typed query
helpers.

Prisma can't model TimescaleDB features in its schema language, and the naive setup
**breaks on `prisma migrate reset` / `migrate dev`**. This package fixes that with:

- 🧱 **Hypertables & continuous aggregates** from `///` schema annotations
- 🧹 **Retention policies** — drop old chunks automatically via `@timescale.retention` or `$timescale`
- ♻️ **Reset-safe migrations** — survive `prisma migrate reset` (proven twice, on real TimescaleDB)
- 🔎 **Typed `timeBucket(...)` queries** with result-row inference and compile-time column checks
- 🛟 **Generator-optional** — the client extension works from a manual config too, so a Prisma
  internal-API change can't fully break you

> **Scope:** hypertables, continuous aggregates, retention policies, reset-safe migrations, typed
> query helpers. Vector / BM25 / hypercore are out of scope for now.

---

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Setup in detail](#setup-in-detail)
- [Runtime usage](#runtime-usage)
- [Data retention (`@timescale.retention`)](#data-retention-timescaleretention)
- [Without the generator](#without-the-generator-manual-config)
- [Renamed tables/columns (`@@map` / `@map`)](#renamed-tablescolumns-map--map)
- [Shadow database](#shadow-database)
- [Annotation reference](#annotation-reference)
- [Troubleshooting](#troubleshooting)
- [Limitations (v0.1)](#limitations-v01)

---

## Requirements

- **Prisma 7** (`prisma` and `@prisma/client` `>=7.0.0`). This release targets Prisma 7 only
  — it relies on the v7 `prisma.config.ts` + `prisma-client` generator model.
- **TimescaleDB-capable PostgreSQL** for both your database and the Prisma **shadow database**
  (see [Shadow database](#shadow-database)). Locally, the
  [`timescale/timescaledb`](https://hub.docker.com/r/timescale/timescaledb) image works.
- A Prisma **driver adapter** at runtime (e.g. `@prisma/adapter-pg`).

## Install

```bash
npm install prisma-extension-timescaledb
npm install -D prisma @prisma/client
npm install @prisma/adapter-pg            # or your preferred driver adapter
```

---

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

---

## Setup in detail

### 1. Connection settings (`prisma.config.ts`)

Prisma 7 moves connection settings out of `schema.prisma` into `prisma.config.ts`:

```ts
import "dotenv/config";
import { defineConfig } from "prisma/config";

export default defineConfig({
  schema: "schema.prisma",
  migrations: { path: "migrations" },
  datasource: {
    url: process.env["DATABASE_URL"],
    // Must point at a TimescaleDB-capable database — see "Shadow database".
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"],
  },
});
```

```dotenv
# .env
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/app?schema=public"
SHADOW_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/shadow?schema=public"
```

### 2. Generate, then migrate

The order matters — **run `prisma generate` before applying migrations** so the emitted SQL
reflects your current annotations:

```bash
npx prisma migrate dev --create-only --name init   # 1. Prisma's own CREATE TABLE migration
npx prisma generate                                # 2. our generator writes the timescale migrations + registry
npx prisma migrate deploy                          # 3. apply all migrations
```

The generator writes two **fixed-name** migrations that bracket your own, so ordering and
idempotency are guaranteed:

| Migration | Sorts | Contents |
| --- | --- | --- |
| `00000000000000_timescaledb_extension/` | **first** | `CREATE EXTENSION IF NOT EXISTS timescaledb` — before any table DDL |
| `99999999999999_timescaledb_objects/` | **last** | `create_hypertable(...)` + continuous aggregates — after Prisma's `CREATE TABLE`s |

All emitted SQL is idempotent (`IF NOT EXISTS`, `if_not_exists => TRUE`), so
`prisma migrate reset` replays it from scratch with zero errors and zero manual steps.

---

## Runtime usage

### Adding data

A hypertable is an ordinary Prisma model, so you insert with the normal Prisma API — no
special calls needed. TimescaleDB routes rows into the right time chunks automatically.

```ts
// single row
await prisma.sensorReading.create({
  data: { time: new Date(), deviceId: 1, temperature: 21.5 },
});

// bulk insert
await prisma.sensorReading.createMany({
  data: [
    { time: new Date("2026-06-15T10:05:00Z"), deviceId: 1, temperature: 20 },
    { time: new Date("2026-06-15T10:25:00Z"), deviceId: 1, temperature: 22 },
    { time: new Date("2026-06-15T11:10:00Z"), deviceId: 1, temperature: 30 },
  ],
});
```

Continuous aggregates are populated by their refresh policy on a schedule; to materialize new
rows immediately (e.g. right after a bulk insert, or in a test), refresh on demand:

```ts
await prisma.$timescale.refreshContinuousAggregate("SensorHourly");
const hourly = await prisma.sensorHourly.findMany({ orderBy: { bucket: "desc" } });
```

### Ad-hoc `time_bucket` queries

```ts
const rows = await prisma.sensorReading.timeBucket({
  bucket: "1 hour",
  range: { start, end },          // both bounds required
  where: {                        // Prisma where operators + AND/OR/NOT
    deviceId: { in: [1, 2] },
    temperature: { gte: 20, lt: 35, not: { equals: 25 } }, // nested `not` is supported
  },
  groupBy: ["deviceId"],
  aggregate: {
    avgTemp: { avg: "temperature" },
    maxTemp: { max: "temperature" },
    samples: { count: "temperature" },
  },
});
// rows: Array<{ bucket: Date; deviceId: number; avgTemp: number; maxTemp: number; samples: number }>
```

Aggregate columns are checked against the model's scalar fields **at compile time**
(avg/sum/min/max require numeric columns), and the result row type is inferred from
`groupBy` + `aggregate`. Supported functions: `avg`, `sum`, `min`, `max`, `count`.

#### Exact aggregate results (`as: "bigint" | "string"`)

By default every aggregate comes back as a JS `number` — `sum`/`avg` are computed as
`double precision`, so a magnitude past `2^53` loses precision. Opt an individual aggregate
into an exact type with `as`:

```ts
const rows = await prisma.sensorReading.timeBucket({
  bucket: "1 hour",
  range: { start, end },
  aggregate: {
    total:   { sum: "deviceId", as: "bigint" },    // → bigint  (exact integer)
    samples: { count: "deviceId", as: "bigint" },  // → bigint  (no overflow past ~2.1B rows)
    exact:   { avg: "temperature", as: "string" }, // → string  (exact decimal, e.g. "22.5000…")
    fast:    { sum: "temperature" },               // → number  (default, unchanged)
  },
});
// rows: Array<{ bucket: Date; total: bigint; samples: bigint; exact: string; fast: number }>
```

- `as: "bigint"` → Postgres `::bigint`, a native JS `bigint`. Exact for integer sums/counts, and
  avoids the overflow the default `count` (`::int`) hits past ~2.1B rows in a single bucket. Not
  available on `avg` (it's fractional).
- `as: "string"` → Postgres `::text`, an exact decimal `string` (JSON-safe). Use for `avg` or
  large fractional sums. Not available on `count`.
- `as: "number"` (default) → JS `number`.

The result-row type follows `as` per aggregate, and the disallowed combinations (`avg` + `bigint`,
`count` + `string`) are compile errors.

### Reading a continuous aggregate

A continuous aggregate is a Prisma `view`, so reads are ordinary, fully-typed Prisma:

```ts
const hourly = await prisma.sensorHourly.findMany({
  where: { bucket: { gte: start }, deviceId: 1 },
  orderBy: { bucket: "desc" },
});
```

### Management (`$timescale`)

```ts
await prisma.$timescale.refreshContinuousAggregate("SensorHourly");              // full refresh
await prisma.$timescale.refreshContinuousAggregate("SensorHourly", { start, end }); // window
```

> **Typo-safe.** The model/view names passed to every `$timescale` method (and
> `addRetentionPolicy` / `removeRetentionPolicy`) are checked against your registered
> hypertables and continuous aggregates — `refreshContinuousAggregate("SensorHrly")` is a
> **compile error**, not a runtime surprise. This works automatically from the generated
> `registry` (and from inline `timescaledb({ hypertables: [...] })` literals); only names built
> from runtime `string` variables fall back to unchecked `string`.

If a scheduled refresh policy happens to be running on the same continuous aggregate, a manual
refresh would otherwise fail with `SQLSTATE 55P03` (*"could not refresh … due to a concurrent
refresh"*). `refreshContinuousAggregate` retries this transient case with bounded exponential
backoff (default: up to 8 attempts); if the contention persists beyond that budget, the original
`55P03` error is rethrown.

---

## Data retention (`@timescale.retention`)

Drop old chunks automatically with a retention policy. Annotate the hypertable model and the
generator emits a **reset-safe** `add_retention_policy(...)` into the managed migration:

```prisma
/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
/// @timescale.retention(dropAfter: "30 days")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
}
```

`dropAfter` is an [interval](#annotation-reference): chunks whose data is older than it are dropped
on TimescaleDB's schedule. The policy survives `prisma migrate reset` like everything else this
package emits.

You can also manage policies at runtime — and this is the path to use with the
[manual config](#without-the-generator-manual-config) (no annotation):

```ts
await prisma.$timescale.addRetentionPolicy("SensorReading", { dropAfter: "30 days" });
await prisma.$timescale.removeRetentionPolicy("SensorReading");
```

> **Changing `dropAfter`:** TimescaleDB won't *update* an existing policy whose interval differs —
> `add_retention_policy(… if_not_exists => TRUE)` keeps the old one and warns. To change the window,
> `removeRetentionPolicy(...)` first (or change the annotation and reset). This is a TimescaleDB
> behavior, not a plugin limitation.

---

## Without the generator (manual config)

The client extension works **without** the generator — pass the config directly:

```ts
const prisma = new PrismaClient({ adapter }).$extends(
  timescaledb({
    hypertables: [{ table: "SensorReading", column: "time", chunkInterval: "1 day" }],
  }),
);
```

The SQL builders are also exported from `prisma-extension-timescaledb/core` for hand-written
migrations: `createExtensionSql`, `createHypertableSql`, `createContinuousAggregateSql`,
`createRetentionPolicySql`.

---

## Renamed tables/columns (`@@map` / `@map`)

`@@map` (table) and `@map` (column) are fully supported. The generator reads the real
database names from the DMMF and emits all SQL against them, while the runtime keeps
accepting and returning **Prisma** field names — so nothing in your application code changes.

```prisma
/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime @map("ts")
  deviceId    Int      @map("device_id")
  temperature Float

  @@id([deviceId, time])
  @@map("sensor_readings")
}
```

```ts
// You still write Prisma field names; the runtime maps them to ts / device_id:
await prisma.sensorReading.timeBucket({
  bucket: "1 hour",
  range: { start, end },
  where: { deviceId: 1 },
  groupBy: ["deviceId"],
  aggregate: { avgTemp: { avg: "temperature" } },
});
```

If you use the **manual config** (no generator), provide the DB names yourself:

```ts
timescaledb({
  hypertables: [{
    model: "SensorReading",                 // Prisma model name (drives prisma.sensorReading.*)
    table: "sensor_readings",               // @@map table
    column: "ts",                           // @map time column
    columns: { deviceId: "device_id" },     // Prisma field -> DB column (where/groupBy/aggregate)
  }],
});
```

### Multiple schemas (`@@schema`)

Multi-schema is supported too. Models annotated with `@@schema("metrics")` (with the
`multiSchema` preview feature) have their hypertables and continuous aggregates created in,
and queried from, the right schema — the generator and runtime schema-qualify every relation
(`"metrics"."sensor_readings"`). No extra configuration needed beyond the standard Prisma
multiSchema setup.

---

## Shadow database

`prisma migrate dev` / `migrate reset` validate migrations against a temporary **shadow
database**. Because the first migration runs `CREATE EXTENSION timescaledb`, the shadow
database must live on a **TimescaleDB-capable server** — set `shadowDatabaseUrl` to a
dedicated database on the same image.

> **Tiger Cloud caveat (honest limitation):** Tiger Cloud rejects Prisma's auto-created
> shadow-database name, so a dedicated `shadowDatabaseUrl` is **mandatory** there. This
> package can't fully paper over that restriction.

A ready-made local setup (`docker-compose.yml` + an init script that creates the `shadow`
database) ships in this repo.

---

## Annotation reference

| Annotation | On | Arguments |
| --- | --- | --- |
| `@timescale.hypertable` | model | `column` (required), `chunkInterval` (default `"7 days"`) |
| `@timescale.retention` | model (also a hypertable) | `dropAfter` (required) — drop chunks older than this interval |
| `@timescale.continuousAggregate` | view | `source`, `bucket`, `timeColumn` (required); `refresh: { startOffset, endOffset, scheduleInterval }` (optional) |
| `@timescale.bucket` | view field | — (exactly one per aggregate) |
| `@timescale.groupBy` | view field | — |
| `@timescale.aggregate` | view field | `fn` (`avg`\|`sum`\|`min`\|`max`\|`count`), `column` |

**Intervals** are `"<amount> <unit>"` where unit is any PostgreSQL interval input unit —
`microsecond(s)`, `millisecond(s)`, `second(s)`, `minute(s)`, `hour(s)`, `day(s)`, `week(s)`,
`month(s)`, `year(s)`, `decade(s)`, or `centur(y|ies)` — validated at compile time *and* runtime
(`"1 hour"`, `"7 days"`, `"2 years"`). (`quarter` is not an interval unit in PostgreSQL; combined
forms like `"1 year 2 months"` aren't supported by this single-unit type.)

---

## Troubleshooting

| Symptom | Cause & fix |
| --- | --- |
| `function create_hypertable(regclass, name) does not exist` | A `::regclass` / `::name` cast leaked into the SQL. This package never emits casts — if you hand-wrote SQL, pass the relation as a quoted string literal (`'"SensorReading"'`) and use `by_range(...)`. |
| `extension "timescaledb" has already been loaded with another version` | Shadow-DB version clash. Ensure the shadow DB is on the **same** TimescaleDB image and don't pin a `VERSION` in `CREATE EXTENSION`. |
| `could not open extension control file` | You're on a non-TimescaleDB Postgres image. Use a `timescale/timescaledb*` image. |
| Shadow-DB name rejected (managed/Tiger Cloud) | Set an explicit `shadowDatabaseUrl` to a dedicated TimescaleDB-capable database. |
| `Views cannot have primary keys` | Prisma 7 disallows `@@id` on views — use `@@unique([...])` on the continuous-aggregate view. |
| `relation "sensorhourly" does not exist` when refreshing | A mixed-case cagg name was passed unquoted and case-folded. `$timescale.refreshContinuousAggregate` already quotes it; if calling raw SQL, pass `'"SensorHourly"'`. |

---

## Limitations (v0.1)

- **`timeBucket` `where`** supports scalar operators (`equals`, `not` — including nested
  `not: { ... }`, e.g. `{ deviceId: { not: { in: [1, 2] } } }` — `in`, `notIn`, `lt`, `lte`, `gt`,
  `gte`, `contains`, `startsWith`, `endsWith` + `mode: "insensitive"`), `null` checks, and
  `AND`/`OR`/`NOT`. Negation matches Prisma's `findMany` semantics, including **NULL exclusion**
  under `not` (SQL three-valued logic). **Relation filters** (`some`/`none`/`every`/`is`) are not
  supported — they can't be a single-table query — and throw a clear error.
- **`timeBucket` numeric precision:** aggregates **default** to JS `number` (`count` → `int`,
  `sum`/`avg` → `double precision`), so a default `sum` beyond 2^53 is float64-rounded. For exact
  results, opt an aggregate into [`as: "bigint"`](#exact-aggregate-results-as-bigint--string)
  (native `bigint`) or `as: "string"` (exact decimal text). (Continuous-aggregate columns use the
  type you declare on the `view` model.)
- Continuous aggregates must be declared as Prisma `view`s with `@@unique` (not `@@id`).

---

## License

MIT © Krister Johansson
