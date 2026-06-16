# Changelog

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
