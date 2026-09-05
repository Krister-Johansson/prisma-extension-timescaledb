-- Runs once, on first container initialization, against the default `app` database.
--
-- Prisma's `migrate dev` validates migrations against a temporary "shadow" database.
-- For TimescaleDB that shadow DB must live on a TimescaleDB-capable server (this same
-- image) so the first migration's `CREATE EXTENSION timescaledb` can run against it too.
--
-- We ONLY create the empty database here. We deliberately do NOT run
-- `CREATE EXTENSION timescaledb` in this script: enabling the extension is the job of
-- the first Prisma migration (kept isolated and idempotent per CLAUDE.md), and doing it
-- here as well can trigger the "extension already loaded with another version" clash.

CREATE DATABASE shadow;

-- Prisma resets the shadow with `DROP SCHEMA "public" CASCADE` before every use, which also
-- drops the extension. Re-creating it restarts TimescaleDB's telemetry job, which holds locks on
-- the extension catalog while it builds its report; a reset that arrives in that window
-- deadlocks, Prisma falls back to `DROP VIEW`, and that fails on a continuous aggregate (P3016).
-- With telemetry off the job takes no locks. See the README's "Shadow database" section.
ALTER DATABASE shadow SET timescaledb.telemetry_level = 'off';
