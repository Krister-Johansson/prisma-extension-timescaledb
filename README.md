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

Type-safe **[TimescaleDB](https://www.tigerdata.com/) / TigerData** time-series support for
Prisma — **reset-safe migrations**, hypertables, continuous aggregates, and typed query helpers.

📖 **[Documentation](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki)** · 📦 **[npm](https://www.npmjs.com/package/prisma-extension-timescaledb)** · 🚀 **[NestJS example](https://github.com/Krister-Johansson/prisma-extension-timescaledb-nestjs-example)**

Prisma can't model TimescaleDB features in its schema language, and the naive setup
**breaks on `prisma migrate reset` / `migrate dev`**. This package fixes that with:

- 🧱 **Hypertables & continuous aggregates** from `///` schema annotations
- 🧹 **Retention policies** — drop old chunks automatically
- 🗜️ **Columnstore compression** — compress old chunks automatically (TimescaleDB hypercore)
- ♻️ **Reset-safe migrations** — survive `prisma migrate reset` (proven on real TimescaleDB)
- 🔎 **Typed `timeBucket(...)` queries** — result-row inference, compile-time column checks,
  gap-filling, and Toolkit hyperfunctions (percentiles, counters, OHLC, …)
- 🛟 **Generator-optional** — the client extension works from a manual config too

> **Scope:** hypertables, continuous aggregates, retention & compression, reset-safe migrations,
> typed query helpers. Vector / BM25 are out of scope for now.

**Using a different ORM?** TigerData's official [`@timescaledb/*`](https://github.com/timescale/timescaledb-ts)
packages cover **TypeORM** and **Sequelize** — this is the **Prisma** counterpart, filling the gap left by
Prisma's inability to model TimescaleDB in its schema language.

## 📖 Documentation

Full docs live in the **[wiki](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki)**:

- [Setup](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Setup) — requirements, `prisma.config.ts`, the generate → migrate flow, shadow database
- [Hypertables](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Hypertables) — chunk interval, space partitioning, chunk skipping
- [Continuous aggregates](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Continuous-Aggregates) — refresh, real-time & hierarchical caggs
- [Retention & compression](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Retention-and-Compression)
- [timeBucket queries](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/timeBucket-Queries) — where, relation filters, `orderBy`/`limit`, gap-filling, time zones
- [Aggregates & hyperfunctions](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Aggregates-and-Hyperfunctions) — every function, exact output, Toolkit hyperfunctions
- [`$timescale` management](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Management) — refresh, chunk ops, resize, background jobs
- [Annotation reference](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Annotation-Reference) · [Without the generator](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Without-the-Generator) · [Troubleshooting](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Troubleshooting)

## Install

```bash
npm install prisma-extension-timescaledb
npm install -D prisma @prisma/client
npm install @prisma/adapter-pg            # or your preferred driver adapter
```

Requires **Prisma 7** and a **TimescaleDB-capable PostgreSQL** (for the database *and* the
Prisma shadow database — locally, the [`timescale/timescaledb`](https://hub.docker.com/r/timescale/timescaledb)
image works). Compression needs TimescaleDB ≥ 2.18; the Toolkit hyperfunctions need
`timescaledb_toolkit` (the `timescale/timescaledb-ha` image, or Tiger Cloud). See
[Setup](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Setup).

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

→ Continue in the **[wiki](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki)** for the full setup, query, and management docs.

## Examples

A runnable **NestJS** app — hypertables, continuous aggregates and `timeBucket` queries wired up end to end:
**[prisma-extension-timescaledb-nestjs-example](https://github.com/Krister-Johansson/prisma-extension-timescaledb-nestjs-example)**.

## Shadow database

`prisma migrate dev` / `migrate reset` validate migrations against a temporary **shadow database**,
and the first migration runs `CREATE EXTENSION timescaledb` — so set **`shadowDatabaseUrl`** (in
`prisma.config.ts`) to a **TimescaleDB-capable** database, not Prisma's default auto-created one:

```ts
// prisma.config.ts
export default defineConfig({
  datasource: {
    url: process.env["DATABASE_URL"],
    shadowDatabaseUrl: process.env["SHADOW_DATABASE_URL"], // a TimescaleDB-capable DB
  },
});
```

> **Tiger Cloud (honest limitation):** Tiger Cloud rejects Prisma's auto-created shadow-database
> name, so a dedicated `shadowDatabaseUrl` is **mandatory** there — this package can't paper over it.
> Full details in [Setup → Shadow database](https://github.com/Krister-Johansson/prisma-extension-timescaledb/wiki/Setup#shadow-database).

## License

MIT © Krister Johansson
