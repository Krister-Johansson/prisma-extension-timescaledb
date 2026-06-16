# SPEC.md — prisma-extension-timescaledb v0.1 (time-series)

This is the design contract for v0.1. It defines the user-facing surface (annotations,
generated types, runtime API) and the exact SQL the generator emits. Implement to this.

---

## 1. User-facing annotation syntax

Users annotate their `schema.prisma` with triple-slash (`///`) comments. The generator
reads these from the DMMF (`model.documentation` / `field.documentation`).

### 1.1 Hypertable

```prisma
/// @timescale.hypertable(column: "time", chunkInterval: "1 day")
model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float
  humidity    Float

  @@index([deviceId, time])
}
```

- `column` (required): the time partitioning column. Must be a `DateTime` field on the model
  (integer time columns are not supported yet — the generator emits interval-based SQL). The
  generator validates this against the DMMF.
- `chunkInterval` (optional, default `"7 days"`): chunk size.

Prisma still owns the `CREATE TABLE`. The generator only appends the hypertable
conversion + emits a branded type for the time column (see §3).

### 1.2 Continuous aggregate

A continuous aggregate is modeled as a Prisma `view` so it is a normal, typed, read-only
model in the client. Field-level annotations declare the aggregation.

```prisma
/// @timescale.continuousAggregate(source: "SensorReading", bucket: "1 hour", timeColumn: "time", refresh: { startOffset: "1 month", endOffset: "1 hour", scheduleInterval: "1 hour" })
view SensorHourly {
  bucket   DateTime  /// @timescale.bucket
  deviceId Int       /// @timescale.groupBy
  avgTemp  Float     /// @timescale.aggregate(fn: "avg", column: "temperature")
  maxTemp  Float     /// @timescale.aggregate(fn: "max", column: "temperature")
}
```

- `source` (required): the hypertable model name.
- `bucket` (required): the `time_bucket` interval.
- `timeColumn` (required): the source model's time column.
- `refresh` (optional): policy offsets; if omitted, no policy is added (manual refresh).
- Field annotations: exactly one `@timescale.bucket`, zero+ `@timescale.groupBy`, one+
  `@timescale.aggregate(fn, column)`. Supported `fn`: `avg | sum | min | max | count` for
  v0.1.

The generator validates the cagg constraints it can see statically: single source, a
bucket field present, aggregates reference real source columns. (Runtime DB constraints
like "no joins" are naturally satisfied because we generate the SQL.)

---

## 2. Emitted migration SQL (the reset-safe core)

The generator emits SQL into Prisma migration files. Ordering and idempotency follow the
hard constraints in `CLAUDE.md`. There are three emission points.

### 2.1 Extension migration (standalone, first, idempotent)

A dedicated migration, e.g. `00000000000000_tiger_init/migration.sql`:

```sql
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
```

Nothing else goes in this migration. It must sort before all others.

### 2.2 Hypertable conversion (after Prisma's CREATE TABLE)

Appended to / following the migration that creates the table. **Cast-free, idempotent:**

```sql
SELECT create_hypertable(
  '"SensorReading"',
  by_range('time', INTERVAL '1 day'),
  if_not_exists => TRUE,
  migrate_data  => TRUE
);
```

Note: relation passed as a quoted string literal `'"SensorReading"'` — NO `::regclass`.
`by_range(...)` is the modern dimension builder; the interval comes from `chunkInterval`.

Down:

```sql
-- Reverting a hypertable means dropping the table; Prisma's own down handles the table.
-- No separate "un-hypertable" step is required.
```

### 2.3 Continuous aggregate (create + policy)

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS "SensorHourly"
  WITH (timescaledb.continuous) AS
SELECT
  time_bucket('1 hour', "time")     AS "bucket",
  "deviceId"                        AS "deviceId",
  avg("temperature")                AS "avgTemp",
  max("temperature")                AS "maxTemp"
FROM "SensorReading"
GROUP BY "bucket", "deviceId"
WITH NO DATA;

SELECT add_continuous_aggregate_policy('"SensorHourly"',
  start_offset      => INTERVAL '1 month',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE
);
```

Down (note MATERIALIZED — see CLAUDE.md constraint 4):

```sql
DROP MATERIALIZED VIEW IF EXISTS "SensorHourly";
```

---

## 3. Generated TypeScript (types + helpers)

The generator emits a module (e.g. `node_modules/.prisma-extension-timescaledb/index.ts` or a configured
output) consumed by the client extension. It produces:

- A **branded time type** per hypertable, marking the partition column so range-bounded
  helpers can require it:
  ```ts
  export type HypertableTime = Date & { readonly __timescaleTime: unique symbol };
  ```
- A **per-cagg row type** matching the view (Prisma already types the `view` model; the
  generator additionally exports an aggregate-spec map used to type `timeBucket`).
- A registry object describing each hypertable (model name, time column, interval) and
  each cagg (source, bucket, aggregates), consumed at runtime.

---

## 4. Runtime client extension API

```ts
import { PrismaClient } from '@prisma/client';
import { timescaledb } from 'prisma-extension-timescaledb';

const prisma = new PrismaClient().$extends(timescaledb());
```

### 4.1 Ad-hoc time_bucket query on a hypertable model

```ts
const rows = await prisma.sensorReading.timeBucket({
  bucket: '1 hour',
  range: { start, end },                 // both required; types are HypertableTime-aware
  where: { deviceId: 1 },                // reuses Prisma's generated where type
  groupBy: ['deviceId'],
  aggregate: {
    avgTemp: { avg: 'temperature' },
    maxTemp: { max: 'temperature' },
  },
});
// Inferred type:
// Array<{ bucket: Date; deviceId: number; avgTemp: number; maxTemp: number }>
```

Implementation: builds `time_bucket($1, "time")` + aggregates from the spec, runs through
`$queryRawTyped` where possible (a generated `.sql` is ideal) or `Prisma.sql` with a typed
return. The `aggregate` spec keys become result keys; the column references are validated
at compile time against the model's scalar fields via `Prisma.Args`-style utilities.

### 4.2 Reading a continuous aggregate

Because the cagg is a Prisma `view`, this is just normal, fully-typed Prisma:

```ts
const hourly = await prisma.sensorHourly.findMany({
  where: { bucket: { gte: start }, deviceId: 1 },
  orderBy: { bucket: 'desc' },
});
// Array<{ bucket: Date; deviceId: number; avgTemp: number; maxTemp: number }>
```

### 4.3 Management namespace

```ts
await prisma.$timescale.refreshContinuousAggregate('SensorHourly', { start, end });
// stretch goal (post-v0.1):
await prisma.$timescale.addRetentionPolicy('SensorReading', { dropAfter: '30 days' });
```

`Interval` inputs use a branded template type to catch typos at compile time:

```ts
type Interval = `${number} ${'second'|'seconds'|'minute'|'minutes'|'hour'|'hours'|'day'|'days'|'week'|'weeks'|'month'|'months'}`;
```

---

## 5. Module layout (single package, v0.1)

```
prisma-extension-timescaledb/
  src/
    core/                 # pure functions: config object -> SQL string ({up,down})
      hypertable.ts       #   createHypertableSql(...)
      continuousAggregate.ts
      extension.ts        #   createExtensionSql()
      interval.ts         #   Interval type + validation
    generator/
      index.ts            # generatorHandler({ onManifest, onGenerate })
      dmmf.ts             # ALL DMMF access isolated here (annotation parsing)
      annotations.ts      # parse `@timescale.*` from documentation strings
      emit-migrations.ts  # writes reset-safe migration .sql via src/core
      emit-types.ts       # writes branded types + registry
    client/
      index.ts            # timescaledb() -> Prisma.defineExtension(...)
      timeBucket.ts       # model method
      manage.ts           # $timescale namespace
    index.ts              # re-exports: timescaledb(), types
  test/
    integration/          # Testcontainers + real TimescaleDB
  package.json            # exports map, peerDeps, tsup build
```

Exports map exposes `.` plus optional subpaths (`./core`) so users can call the SQL
builders directly in hand-written migrations if they prefer.

---

## 6. Explicit non-goals for v0.1

- pgvector / pgvectorscale, BM25 / `pg_textsearch`, hypercore / columnstore.
- Auto-managing `shadowDatabaseUrl` (we document it; we don't automate it).
- Solving the Tiger Cloud shadow-DB name restriction (documented limitation).
- A standalone CLI. The generator runs through `prisma generate`.
