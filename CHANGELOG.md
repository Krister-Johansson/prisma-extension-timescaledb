# Changelog

All notable changes to this project are documented here. The format is based on
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] — Unreleased

Initial release. Time-series support for Prisma 7 on TimescaleDB / TigerData.

### Added

- **Reset-safe migrations.** A Prisma generator that emits an isolated, idempotent
  `CREATE EXTENSION` migration (sorts first) and a consolidated hypertable + continuous
  aggregate migration (sorts last). Verified to survive `prisma migrate reset` run twice
  against a real TimescaleDB (Testcontainers).
- **Annotations.** `@timescale.hypertable`, `@timescale.continuousAggregate`, and the field
  annotations `@timescale.bucket` / `@timescale.groupBy` / `@timescale.aggregate`, validated
  against the Prisma DMMF.
- **Core SQL builders** (`prisma-extension-timescaledb/core`): `createExtensionSql`,
  `createHypertableSql`, `createContinuousAggregateSql`, and an `Interval` type + validator.
- **Client extension** (`timescaledb()`): typed `model.timeBucket(...)` with result-row
  inference, and a `$timescale.refreshContinuousAggregate(...)` management method. Works with
  the generated registry or a manual config (no generator required).

### Known limitations

- `timeBucket` `where` supports top-level equality only at runtime.
- Table name must equal the model name (`@@map` not yet supported).
- `sum`/`avg` over integer columns may return `bigint`/`numeric` while typed as `number`.
- Out of scope for v0.1: pgvector, BM25, hypercore/columnstore, retention policies.
