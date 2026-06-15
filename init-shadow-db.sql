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
