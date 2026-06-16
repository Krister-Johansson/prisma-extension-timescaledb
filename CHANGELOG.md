# Changelog

## [0.5.0](https://github.com/Krister-Johansson/prisma-extension-timescaledb/compare/prisma-extension-timescaledb-v0.4.1...prisma-extension-timescaledb-v0.5.0) (2026-06-16)


### Features

* $timescale chunk + size helpers (drop_chunks + introspection) ([#26](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/26)) ([8907a97](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/8907a978a064db97b9d65740157322bc6ee567a6))
* $timescale.setChunkInterval (resize a live hypertable) ([#31](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/31)) ([41845d0](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/41845d01c53ee01b3501c76c5a34a2a62d7ea0f2))
* chunk skipping (enable/disable_chunk_skipping) ([#30](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/30)) ([f06662b](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/f06662b67b14b1ec14e06baefb2e386f09869171))
* continuous-aggregate refresh-policy management ($timescale) ([#29](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/29)) ([d4d1eea](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/d4d1eeae61d68e9c7a500f93bae15982adf26ab3))
* first() / last() aggregates in timeBucket ([#25](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/25)) ([30c2141](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/30c2141c6a2970e2c717ed4b9b5d07e3a08cc96d))
* gap-filling in timeBucket (gapfill + locf / interpolate) ([#23](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/23)) ([d180616](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/d18061615cbf82f861b2b4e4cb971a76ee1d5241))
* hash space partitioning (add_dimension + by_hash) ([#28](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/28)) ([07ea8e9](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/07ea8e9808dd20c8874494d9b6c6518affcaf17d))
* timezone / origin / offset for timeBucket ([#27](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/27)) ([bc08a87](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/bc08a8728ba56047c6876d7d8ba6fec03c72c771))

## [0.4.1](https://github.com/Krister-Johansson/prisma-extension-timescaledb/compare/prisma-extension-timescaledb-v0.4.0...prisma-extension-timescaledb-v0.4.1) (2026-06-16)


### Bug Fixes

* reject unsupported integer time columns and non-positive intervals up front ([#21](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/21)) ([08adde3](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/08adde33b5ab4c1722adb8928ef88c9d5b123f30))

## [0.4.0](https://github.com/Krister-Johansson/prisma-extension-timescaledb/compare/prisma-extension-timescaledb-v0.3.0...prisma-extension-timescaledb-v0.4.0) (2026-06-16)


### Features

* nest relation filters through other relations in `timeBucket` where ([#19](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/19)) ([d50266f](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/d50266f85c5463c4f7bcff1cfa67825adaaba377))

## [0.3.0](https://github.com/Krister-Johansson/prisma-extension-timescaledb/compare/prisma-extension-timescaledb-v0.2.0...prisma-extension-timescaledb-v0.3.0) (2026-06-16)


### Features

* columnstore compression policies (`@timescale.compression` + `$timescale`) ([#16](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/16)) ([00e485a](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/00e485a1b2013449ed0adfc28ad4cd6806fd54f2))

## [0.2.0](https://github.com/Krister-Johansson/prisma-extension-timescaledb/compare/prisma-extension-timescaledb-v0.1.0...prisma-extension-timescaledb-v0.2.0) (2026-06-16)


### Features

* data retention policies and type-safe $timescale names ([#12](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/12)) ([bcc95e4](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/bcc95e45bcb503623b47f87d19de6d8838afb3ca))
* exact timeBucket aggregates via `as: "bigint" | "string"` ([#11](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/11)) ([2c6cc3b](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/2c6cc3bd9df281a775a20fd446044638dda3ad95))
* relation filters (some/none/every/is/isNot) in timeBucket where ([#14](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/14)) ([7dbf1f2](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/7dbf1f219d23000c9fb6b7feaceb898747078f40))
* return timeBucket sum/avg as JS numbers (cast to double precision) ([#8](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/8)) ([f510695](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/f51069516cbb3db64363d4da6f6049e5724d0a04))
* support `@@schema` (multiSchema) ([#9](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/9)) ([b17b17e](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/b17b17e4e7270f0d051ebd7c9388fae7055fefef))
* support nested `not: { ... }` in timeBucket where ([#13](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/13)) ([67a5f68](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/67a5f6840d9209f2dfb6959019931ace4ae3ba32))
* support Prisma where operators in timeBucket ([#4](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/4)) ([ec6b898](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/ec6b8986a39581e7e09aae7b4f2588a289057c11))


### Bug Fixes

* retry refresh_continuous_aggregate on a concurrent policy refresh (55P03) ([#10](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/10)) ([e43ddf0](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/e43ddf0119036a388b919034bef1bcf5be709460))

## 0.1.0 (2026-06-15)

### Features

* prisma-extension-timescaledb v0.1 (time-series) ([#1](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/1)) ([62f69b7](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/62f69b7cf7b03bad4c3af312d441eae1e9c03990))
* support `@@map` and `@map` (table & column renaming) ([#3](https://github.com/Krister-Johansson/prisma-extension-timescaledb/issues/3)) ([5b94f93](https://github.com/Krister-Johansson/prisma-extension-timescaledb/commit/5b94f937ba0e9323f5fef1d9c47a4b37bd4f028d))
