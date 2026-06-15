# SPIKE.md — reset-safety proof (do this before building the package)

Goal: prove, on real Docker, that a TimescaleDB hypertable + continuous aggregate survive
`prisma migrate reset` with zero manual steps — using **hand-written** migration SQL.

Why first: the package's whole value is emitting reset-safe migrations. Proving the
pattern by hand (a) confirms the Docker/shadow-DB setup works, (b) surfaces gotchas before
you've written package code, and (c) produces the **exact migration SQL the generator will
later emit** (SPEC.md §2). Once this spike is green, the generator's job is just to
reproduce this proven SQL from annotations.

This is a throwaway. Put it in a `spike/` folder or a scratch repo; delete it once the
package's Milestone 5 reproduces the same guarantee from generated migrations.

---

## Steps

### 1. Database up

```bash
docker compose up -d
# confirm the extension is AVAILABLE in the image and can be ENABLED:
docker exec -it prisma_timescaledb psql -U postgres -d app -c \
  "CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE; SELECT extversion FROM pg_extension WHERE extname='timescaledb';"
```
If that prints a version, availability + enabling both work. (If it errors with "could
not open extension control file", you're on a non-TimescaleDB image — fix the image.)

### 2. Scaffold with the Prisma CLI, then edit the generated files

Do NOT hand-create `schema.prisma` or `.env` — let the CLI generate them, then edit.

```bash
cd spike
npx prisma init        # creates prisma/schema.prisma and .env (with a placeholder URL)
```

**Update the generated `.env`** to match `docker-compose.yml` (user/pass `postgres`, port
`5432`, databases `app` + `shadow`):
```
DATABASE_URL="postgresql://postgres:postgres@localhost:5432/app?schema=public"
SHADOW_DATABASE_URL="postgresql://postgres:postgres@localhost:5432/shadow?schema=public"
```

**Edit the generated `prisma/schema.prisma`** — add `shadowDatabaseUrl`, the `views`
preview feature, and the minimal models:
```prisma
datasource db {
  provider          = "postgresql"
  url               = env("DATABASE_URL")
  shadowDatabaseUrl = env("SHADOW_DATABASE_URL")
}

generator client {
  provider        = "prisma-client-js"
  previewFeatures = ["views"]
}

model SensorReading {
  time        DateTime
  deviceId    Int
  temperature Float

  @@id([deviceId, time])
  @@index([deviceId, time])
}

/// continuous aggregate, surfaced as a read-only view
view SensorHourly {
  bucket   DateTime
  deviceId Int
  avgTemp  Float

  @@id([deviceId, bucket])
}
```

### 3. Hand-written migrations (the reset-safe pattern)

Create the migrations with `--create-only` so you can edit the SQL, then apply.

**Migration A — extension only (standalone, leading, idempotent):**
`spike/prisma/migrations/00000000000000_timescaledb_extension/migration.sql`
```sql
CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;
```

**Migration B — table + hypertable conversion.** Let Prisma generate the `CREATE TABLE`
(`prisma migrate dev --create-only --name init`), then append the cast-free, idempotent
conversion:
```sql
-- (Prisma's generated CREATE TABLE "SensorReading" ... stays above)

SELECT create_hypertable(
  '"SensorReading"',
  by_range('time', INTERVAL '1 day'),
  if_not_exists => TRUE,
  migrate_data  => TRUE
);
```
Note: relation as a quoted string literal `'"SensorReading"'` — NO `::regclass` / `::name`
casts (those break inside Prisma's migration engine even though they work in psql).

**Migration C — continuous aggregate + policy (idempotent):**
```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS "SensorHourly"
  WITH (timescaledb.continuous) AS
SELECT time_bucket('1 hour', "time") AS "bucket",
       "deviceId"                    AS "deviceId",
       avg("temperature")            AS "avgTemp"
FROM "SensorReading"
GROUP BY "bucket", "deviceId"
WITH NO DATA;

SELECT add_continuous_aggregate_policy('"SensorHourly"',
  start_offset      => INTERVAL '1 month',
  end_offset        => INTERVAL '1 hour',
  schedule_interval => INTERVAL '1 hour',
  if_not_exists     => TRUE);
```
Down (if you add one): `DROP MATERIALIZED VIEW IF EXISTS "SensorHourly";` — note
MATERIALIZED; plain `DROP VIEW` errors on a cagg.

### 4. The proof test

A script / test that asserts reset-safety end to end:

```bash
# apply from scratch
npx prisma migrate reset --force        # drops everything, replays all migrations

# assert the objects exist
docker exec prisma_timescaledb psql -U postgres -d app -tAc \
  "SELECT count(*) FROM timescaledb_information.hypertables WHERE hypertable_name='SensorReading';"
# expect: 1
docker exec prisma_timescaledb psql -U postgres -d app -tAc \
  "SELECT count(*) FROM timescaledb_information.continuous_aggregates WHERE view_name='SensorHourly';"
# expect: 1

# THE KEY ASSERTION: reset again and re-verify — proves idempotent replay
npx prisma migrate reset --force
# re-run the two counts above; both must still be 1, with no errors
```

Wrap the above in your test runner (e.g. a Vitest e2e test that shells out and asserts the
counts). Insert a few rows, `CALL refresh_continuous_aggregate('SensorHourly', NULL, NULL);`
and assert the cagg returns expected values, to confirm the pipeline actually works.

---

## Done when

- `prisma migrate reset --force` run twice in a row leaves exactly one hypertable and one
  continuous aggregate, with zero manual steps and zero errors.
- The proven migration SQL above is copied into the package as the generator's emission
  template (SPEC.md §2). Then delete the spike.

## If it fails

- `could not open extension control file` → wrong image (not a TimescaleDB image).
- `function create_hypertable(regclass, name) does not exist` → you left `::regclass` /
  `::name` casts in; remove them.
- `extension "timescaledb" has already been loaded with another version` → shadow-DB
  version clash; ensure the shadow DB is on the SAME image, and don't pin a VERSION in
  `CREATE EXTENSION`.
- shadow-DB name rejected (only on managed/Tiger Cloud) → use an explicit
  `shadowDatabaseUrl` (the compose setup already provides one locally).
