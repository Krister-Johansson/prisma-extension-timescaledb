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
- 🗜️ **Columnstore compression** — compress old chunks automatically via `@timescale.compression` or `$timescale` (TimescaleDB hypercore)
- ♻️ **Reset-safe migrations** — survive `prisma migrate reset` (proven twice, on real TimescaleDB)
- 🔎 **Typed `timeBucket(...)` queries** with result-row inference, compile-time column checks, and gap-filling (`locf` / `interpolate`)
- 🛟 **Generator-optional** — the client extension works from a manual config too, so a Prisma
  internal-API change can't fully break you

> **Scope:** hypertables, continuous aggregates, retention & compression policies, reset-safe
> migrations, typed query helpers. Vector / BM25 are out of scope for now.

---

## Contents

- [Requirements](#requirements)
- [Install](#install)
- [Quick start](#quick-start)
- [Setup in detail](#setup-in-detail)
- [Runtime usage](#runtime-usage)
- [Data retention (`@timescale.retention`)](#data-retention-timescaleretention)
- [Data compression (`@timescale.compression`)](#data-compression-timescalecompression)
- [Without the generator](#without-the-generator-manual-config)
- [Renamed tables/columns (`@@map` / `@map`)](#renamed-tablescolumns-map--map)
- [Shadow database](#shadow-database)
- [Annotation reference](#annotation-reference)
- [Troubleshooting](#troubleshooting)
- [Limitations](#limitations)

---

## Requirements

- **Prisma 7** (`prisma` and `@prisma/client` `>=7.0.0`). This release targets Prisma 7 only
  — it relies on the v7 `prisma.config.ts` + `prisma-client` generator model.
- **TimescaleDB-capable PostgreSQL** for both your database and the Prisma **shadow database**
  (see [Shadow database](#shadow-database)). Locally, the
  [`timescale/timescaledb`](https://hub.docker.com/r/timescale/timescaledb) image works.
  [Compression](#data-compression-timescalecompression) additionally needs **TimescaleDB ≥ 2.18**
  (the columnstore API).
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
`groupBy` + `aggregate`. Supported functions: `avg`, `sum`, `min`, `max`, `count`, and
[`first` / `last`](#earliest--latest-value-first--last).

#### Relation filters (`some` / `none` / `every` / `is` / `isNot`)

Filter a hypertable by a **related** model's fields. The generator reads your schema's relations
and the runtime compiles them to `EXISTS` subqueries:

```ts
const rows = await prisma.sensorReading.timeBucket({
  bucket: "1 hour",
  range: { start, end },
  where: {
    device: { is: { active: true } },     // to-one: the related device is active
    tags:   { some: { label: "prod" } },  // to-many: has ≥1 matching tag
    alerts: { every: { resolved: true } },// to-many: all resolved (vacuously true if none)
    owner:  { isNot: null },              // relation exists
  },
  aggregate: { n: { count: "deviceId" } },
});
```

Results match Prisma's `findMany` exactly, including `every`'s vacuous truth and NULL handling
(`is`/`isNot: null` test relation existence). Composite foreign keys are supported, and relation
filters **nest through other relations to any depth** — each level compiles to a correlated
`EXISTS`:

```ts
// sensor readings whose device also has a reading over 30° (Reading → device → readings)
where: { device: { is: { readings: { some: { temperature: { gt: 30 } } } } } }
```

The only requirement is that the models you traverse are visible to the generator (or supplied via
the [manual config](#without-the-generator-manual-config)).

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

#### Gap-filling empty buckets (`gapfill` + `fill`)

By default `timeBucket` returns only buckets that have rows. Set `gapfill: true` to emit a row for
**every** bucket across `range` (TimescaleDB `time_bucket_gapfill`), then fill the empty ones per
aggregate:

```ts
const rows = await prisma.sensorReading.timeBucket({
  bucket: "1 hour",
  range: { start, end },
  gapfill: true,
  aggregate: {
    avgTemp: { avg: "temperature", fill: "locf" },        // carry the last value forward
    smooth:  { avg: "temperature", fill: "interpolate" }, // linear interpolation
    raw:     { avg: "temperature" },                      // null in empty buckets
  },
});
// rows: Array<{ bucket: Date; avgTemp: number | null; smooth: number | null; raw: number | null }>
```

- `fill: "locf"` carries the last observed value forward into empty buckets; `fill: "interpolate"`
  linearly interpolates between the surrounding values. Both are `null` at the range edges where
  there's no neighbouring value, and gap-filling happens **per `groupBy` group**.
- **Under `gapfill`, every aggregate becomes nullable** — its base type still follows `as` / `fill`
  (so an unfilled `{ sum, as: "bigint" }` comes back as `bigint | null`), since empty buckets have no data.
- `fill` requires `gapfill: true` and is mutually exclusive with
  [`as`](#exact-aggregate-results-as-bigint--string) (a carried/interpolated value is a JS `number`,
  not an exact bigint/decimal).

#### Earliest / latest value (`first` / `last`)

`first` / `last` return the value of one column at the **earliest / latest time** in each bucket
(TimescaleDB `first(value, time)` / `last(value, time)`) — e.g. the open/close price per hour:

```ts
const rows = await prisma.sensorReading.timeBucket({
  bucket: "1 hour",
  range: { start, end },
  groupBy: ["deviceId"],
  aggregate: {
    open:  { first: "temperature" }, // value at the earliest time in the bucket
    close: { last: "temperature" },  // value at the latest time
    tag:   { last: "label" },        // any column type — keeps the column's type
  },
});
// rows: Array<{ bucket: Date; deviceId: number; open: number; close: number; tag: string }>
```

- Ordered by the model's **time column by default**; pass `by: "<field>"` to order by another column.
- `first` / `last` accept **any** column and the result keeps that column's type. They take no
  `as` / `fill`, and are `null` in empty buckets under `gapfill`.

#### Time zones & bucket alignment (`timezone` / `origin` / `offset`)

```ts
const rows = await prisma.sensorReading.timeBucket({
  bucket: "1 day",
  range: { start, end },
  timezone: "Europe/Stockholm", // day/week/month buckets align to this zone's calendar (DST-aware)
  // origin: new Date("2026-01-01T00:00:00Z"), // align buckets to an instant
  // offset: "6 hours",                        // shift bucket boundaries by an interval
  aggregate: { avgTemp: { avg: "temperature" } },
});
```

- `timezone` requires a **`timestamptz` time column** (`@db.Timestamptz`) — calendar bucketing is
  undefined for a tz-naive column; without it, `time_bucket` aligns to UTC.
- `origin` (a `Date`) and `offset` (an interval) shift the bucket boundaries. `origin` + `offset`
  together require a `timezone`, and none of `timezone` / `origin` / `offset` combine with `gapfill` yet.

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

// Manage the cagg's refresh policy at runtime — the complement of the `refresh: { … }` annotation
// (and the way to set one on the manual-config path):
await prisma.$timescale.addContinuousAggregatePolicy("SensorHourly", {
  startOffset: "1 month",
  endOffset: "1 hour",
  scheduleInterval: "1 hour",
});
await prisma.$timescale.removeContinuousAggregatePolicy("SensorHourly");
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

#### Inspecting & dropping chunks

```ts
// On-demand chunk drop (manual retention) — returns the dropped chunk names.
const dropped = await prisma.$timescale.dropChunks("SensorReading", { olderThan: "30 days" });

// Size, row-count, and compression introspection — sizes/counts come back as exact `bigint`.
const bytes  = await prisma.$timescale.hypertableSize("SensorReading");         // bigint (total bytes)
const detail = await prisma.$timescale.hypertableDetailedSize("SensorReading"); // { tableBytes, indexBytes, toastBytes, totalBytes }
const rows   = await prisma.$timescale.approximateRowCount("SensorReading");    // bigint (planner estimate; fast)
const stats  = await prisma.$timescale.compressionStats("SensorReading");       // { totalChunks, compressedChunks, beforeTotalBytes, afterTotalBytes }
```

`dropChunks` bounds (`olderThan` / `newerThan`) are intervals **relative to now** (combine both for a
window), matching `@timescale.retention`'s `dropAfter` — absolute-timestamp cutoffs aren't supported.
The introspection helpers wrap `hypertable_size`, `hypertable_detailed_size`, `approximate_row_count`,
and `hypertable_columnstore_stats`.

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

## Data compression (`@timescale.compression`)

Compress old chunks automatically with TimescaleDB's **columnstore** (hypercore). Annotate the
hypertable model and the generator emits a **reset-safe** policy into the managed migration:

```prisma
/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
/// @timescale.compression(after: "7 days", segmentBy: "deviceId", orderBy: "time DESC")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
}
```

- `after` (required) is an [interval](#annotation-reference): chunks older than it are converted to
  the columnstore on TimescaleDB's schedule.
- `segmentBy` (optional) — the column(s) the columnstore groups rows by; the **main tuning knob**
  (queries that filter/group by these stay fast, and compression ratios improve). One Prisma field
  name, or several comma-separated.
- `orderBy` (optional) — ordering *within* each segment, e.g. `"time DESC"` (comma-separate for
  several, each `field [ASC|DESC] [NULLS FIRST|LAST]`).

`segmentBy` and `orderBy` take **Prisma field names** and are mapped to the underlying `@map`
columns. The policy survives `prisma migrate reset` like everything else this package emits.

Under the hood the generator emits the two statements TimescaleDB needs — enable the columnstore,
then add the policy (`add_columnstore_policy` is a procedure, hence `CALL`):

```sql
ALTER TABLE "SensorReading" SET (
  timescaledb.enable_columnstore = true,
  timescaledb.segmentby = '"deviceId"',
  timescaledb.orderby = '"time" DESC'
);
CALL add_columnstore_policy('"SensorReading"', after => INTERVAL '7 days', if_not_exists => TRUE);
```

You can also manage policies at runtime — and this is the path to use with the
[manual config](#without-the-generator-manual-config) (no annotation):

```ts
await prisma.$timescale.addCompressionPolicy("SensorReading", {
  after: "7 days",
  segmentBy: "deviceId",            // or ["deviceId", "siteId"]
  orderBy: "time DESC",             // or [{ column: "time", direction: "desc" }]
});
await prisma.$timescale.removeCompressionPolicy("SensorReading");
```

> **Requires TimescaleDB ≥ 2.18** — the columnstore API (`enable_columnstore` /
> `add_columnstore_policy`). On older versions use the legacy `compress` API by hand.

> **Changing `segmentBy` / `orderBy` / `after`:** like retention, TimescaleDB won't *update* an
> existing policy in place — `add_columnstore_policy(… if_not_exists => TRUE)` keeps the old one, and
> changed segment/order settings apply only to **future** compressions. To change them,
> `removeCompressionPolicy(...)` first (or change the annotation and reset). `removeCompressionPolicy`
> stops the policy but leaves the columnstore enabled — disabling it fails once chunks are compressed.

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
`createRetentionPolicySql`, `createCompressionPolicySql`.

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
| `@timescale.hypertable` | model | `column` (required), `chunkInterval` (default `"7 days"`); `partitionColumn` + `partitions` (optional) — a hash space dimension |
| `@timescale.retention` | model (also a hypertable) | `dropAfter` (required) — drop chunks older than this interval |
| `@timescale.compression` | model (also a hypertable) | `after` (required) — compress chunks older than this; `segmentBy`, `orderBy` (optional) — columnstore tuning (Prisma field names) |
| `@timescale.continuousAggregate` | view | `source`, `bucket`, `timeColumn` (required); `refresh: { startOffset, endOffset, scheduleInterval }` (optional) |
| `@timescale.bucket` | view field | — (exactly one per aggregate) |
| `@timescale.groupBy` | view field | — |
| `@timescale.aggregate` | view field | `fn` (`avg`\|`sum`\|`min`\|`max`\|`count`), `column` |

**Intervals** are `"<amount> <unit>"` where unit is any PostgreSQL interval input unit —
`microsecond(s)`, `millisecond(s)`, `second(s)`, `minute(s)`, `hour(s)`, `day(s)`, `week(s)`,
`month(s)`, `year(s)`, `decade(s)`, or `centur(y|ies)` — validated at compile time *and* runtime
(`"1 hour"`, `"7 days"`, `"2 years"`). (`quarter` is not an interval unit in PostgreSQL; combined
forms like `"1 year 2 months"` aren't supported by this single-unit type.)

**Space partitioning** — add `partitionColumn` + `partitions` to `@timescale.hypertable` for a hash
space dimension (`add_dimension(..., by_hash(column, partitions))`) on top of the time dimension:

```prisma
/// @timescale.hypertable(column: "time", chunkInterval: "1 day", partitionColumn: "deviceId", partitions: 4)
model SensorReading {
  time     DateTime
  deviceId Int

  @@id([deviceId, time]) // a partitioning column must be part of the table's PK / unique key
}
```

`partitionColumn` takes a Prisma field name (mapped to its `@map` column); `partitions` is a positive
integer. It's transparent to `timeBucket` queries and survives `prisma migrate reset` like everything
else this package emits.

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

## Limitations

`timeBucket` `where` now covers Prisma's full scalar + logical operators **and** relation filters
(`some`/`none`/`every`/`is`/`isNot`), including relation filters **nested through other relations to
any depth** — see [Runtime usage](#runtime-usage). What's left:

- **Relation filters** — the models you traverse must be visible to the generator (or supplied via
  the [manual config](#without-the-generator-manual-config)); a relation to a model the generator
  can't see isn't available for filtering.
- **`timeBucket` numeric precision:** aggregates **default** to JS `number` (`count` → `int`,
  `sum`/`avg` → `double precision`), so a default `sum` beyond 2^53 is float64-rounded. For exact
  results, opt an aggregate into [`as: "bigint"`](#exact-aggregate-results-as-bigint--string)
  (native `bigint`) or `as: "string"` (exact decimal text). (Continuous-aggregate columns use the
  type you declare on the `view` model.)
- **Continuous aggregates** must use `@@unique` (not `@@id`) — a **Prisma constraint** (Prisma 7:
  *"Views cannot have primary keys"*), not a limitation of this package.

---

## License

MIT © Krister Johansson
