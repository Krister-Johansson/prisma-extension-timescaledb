# BUILD_PLAN.md — prisma-extension-timescaledb v0.1

Work through these milestones in order. After each, run the relevant tests and **stop for
human review** before starting the next. Do not implement out-of-scope features
(§6 of SPEC.md). The reset-safety guarantee (CLAUDE.md) is the acceptance bar that
matters most — it is verified in Milestone 5.

---

## Milestone S — Reset-safety spike (recommended pre-step)

Before scaffolding the package, run the proof spike in `SPIKE.md`: a throwaway minimal
Prisma project with hand-written migrations that proves a hypertable + continuous
aggregate survive `prisma migrate reset` (twice), on the real `docker-compose.yml`
database. This de-risks the hard part and yields the exact migration SQL the generator
emits in Milestone 3. Keep the proven SQL; delete the spike once Milestone 5 reproduces
the guarantee from generated migrations.
- **Gate:** double `migrate reset` leaves exactly one hypertable and one cagg, zero manual
  steps, zero errors.

---

## Milestone 0 — Scaffold

- Init TypeScript package: `strict: true`, `module`/`moduleResolution: NodeNext`,
  `target: ES2022`, `declaration: true`.
- `tsup` for dual ESM/CJS build; `exports` map per SPEC §5; `"sideEffects": false`.
- `@prisma/client` + `prisma` as `peerDependencies` (`>=6.13`), and as devDependencies
  (pin a concrete version) for tests. Add `pgvector` is NOT needed in v0.1.
- Scripts: `build`, `test`, `attw` (`@arethetypeswrong/cli` against the tarball).
- **Gate:** `npm run build` produces valid ESM + CJS + types; `attw` is clean.

## Milestone 1 — Core SQL builders (`src/core`)

Pure, dependency-light functions: config object in, `{ up: string; down: string }` out.
- `createExtensionSql()` → idempotent `CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;`
- `createHypertableSql({ table, column, chunkInterval })` → cast-free, idempotent form
  from SPEC §2.2. **Assert in a unit test that the output contains no `::regclass` and no
  `::name`.**
- `createContinuousAggregateSql({ name, source, bucket, timeColumn, groupBy, aggregates,
  refresh? })` → SPEC §2.3; down uses `DROP MATERIALIZED VIEW IF EXISTS`.
- `Interval` type + a runtime validator.
- **Gate:** unit tests cover each builder's up/down strings, including the idempotency
  guards and the no-cast assertion. No DB needed yet.

## Milestone 2 — Annotation parsing + DMMF (`src/generator/dmmf.ts`, `annotations.ts`)

- Parse `@timescale.hypertable(...)`, `@timescale.continuousAggregate(...)`, and the field
  annotations (`@timescale.bucket|groupBy|aggregate`) from documentation strings.
- Validate against the DMMF: time column exists and is a date/int field; cagg source is a
  known model; aggregate columns exist on the source; exactly one bucket field.
- Keep **all** `options.dmmf` access in `dmmf.ts`. Everything else consumes a clean
  internal shape (`HypertableConfig`, `CaggConfig`).
- Use `getDMMF()` from `@prisma/internals` in tests to feed sample schemas — no spawning.
- **Gate:** given fixture schemas (valid + each invalid case), parsing yields the expected
  configs or precise errors.

## Milestone 3 — Generator emission (`src/generator/index.ts`, `emit-*.ts`)

- `generatorHandler({ onManifest, onGenerate })`. On generate: produce the configs
  (M2), then emit via M1 builders.
- Migration emission: write the standalone extension migration first; emit hypertable and
  cagg SQL in correctly ordered migration files. Make emission **deterministic and
  re-runnable** (regenerating an unchanged schema produces no spurious diffs).
- Type emission: branded `HypertableTime`, the runtime registry, aggregate-spec maps.
- **Gate:** running the generator on the sample schema writes the expected migration files
  (snapshot test) and a type module that type-checks.

## Milestone 4 — Client extension (`src/client`)

- `timescaledb()` → `Prisma.defineExtension(...)`. Must also accept a manual config object so it
  works WITHOUT the generator (CLAUDE.md resilience requirement).
- `model.timeBucket(...)` per SPEC §4.1: typed args (bucket, required range, where reusing
  Prisma's where, groupBy, aggregate spec), typed result row inferred from the spec.
  Prefer `$queryRawTyped` with a generated `.sql`; fall back to `Prisma.sql` + explicit
  return type. Validate aggregate column names against model scalars at compile time.
- `$timescale.refreshContinuousAggregate(name, { start, end })`.
- **Gate:** type-level tests (e.g. `tsd` or `expect-type`) prove the result types infer
  correctly and that bad aggregate columns / missing range fail to compile.

## Milestone 5 — Integration tests (the reset-safety proof)

Testcontainers with a TimescaleDB image (e.g. `timescale/timescaledb-ha`). Configure a
**separate TimescaleDB-capable shadow database** in the test env.
- Apply migrations; assert the hypertable exists (`timescaledb_information.hypertables`)
  and the cagg exists with its policy (`timescaledb_information.continuous_aggregates` /
  `jobs`).
- **THE KEY TEST:** run `prisma migrate reset --force` then `prisma migrate deploy`, and
  assert hypertables + caggs are fully reproduced with zero manual steps and zero errors.
  Run it twice to prove idempotency.
- Insert rows, refresh the cagg, run `timeBucket(...)` and a cagg `findMany`, assert typed
  results match expected values.
- **Gate:** all integration tests green. If Docker is unavailable, the suite must skip
  with a clear message, not silently pass.

## Milestone 6 — Docs + publish prep

- README: install, `shadowDatabaseUrl` setup (with the honest Tiger Cloud caveat from
  CLAUDE.md constraint 5), annotation reference, the `timeBucket` / cagg examples, and a
  Prisma version compatibility note.
- `CHANGELOG.md`, LICENSE (MIT), `prepublishOnly` runs build + attw + tests.
- **Gate:** `npm pack` dry run; `attw` clean; README examples compile.

---

## Stretch (only after v0.1 ships and is reviewed)

- `$timescale.addRetentionPolicy(...)` + emitted `add_retention_policy(... if_not_exists =>
  TRUE)` — small, high-value, and absent from the official package.
- Hypercore/columnstore policy emission.
- Then the harder track: pgvector + BM25 (custom types/operators, branded result types).

## Open questions to surface during the build (don't silently decide)

1. Generator output location for the type module and `.sql` files, and how the client
   extension imports them across ESM/CJS.
2. Whether to model caggs strictly as Prisma `view`s (requires the `views` preview
   feature) or also support a non-view fallback.
3. Exact minimum Prisma version where `by_range(...)`-style emission + TypedSQL behave;
   pin the matrix once integration tests run against 1–2 Prisma minors.
