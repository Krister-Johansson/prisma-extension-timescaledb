// Extension setup SQL builder (SPEC §2.1 / CLAUDE.md constraint 1).
import type { MigrationSql } from "./types.js";

/**
 * Build the standalone, idempotent extension-setup migration. This must be emitted as its
 * own leading migration, before any table or hypertable DDL (CLAUDE.md constraint 1), and
 * is idempotent so `migrate reset` can replay it from scratch without error (constraint 3).
 *
 * `timescaledb.control` sets neither `schema` nor `relocatable = true`, so a bare
 * `CREATE EXTENSION` installs into the first existing schema on the search path. Prisma runs
 * migrations with `search_path` set to the datasource schema alone (`?schema=data_collection`),
 * which makes that placement follow the application's own schema, and fail outright with
 * `no schema has been selected to create in` when the schema is only created by a later
 * migration. Pinning `public` keeps the extension where TimescaleDB's docs and every generated
 * block expect it. The fallback covers a database whose `public` schema was dropped, and the
 * leading existence check leaves an extension that already lives elsewhere alone.
 */
export function createExtensionSql(): MigrationSql {
  const up = `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN RETURN; END IF;
  IF to_regnamespace('public') IS NOT NULL THEN
    EXECUTE 'CREATE EXTENSION timescaledb WITH SCHEMA public CASCADE';
  ELSE
    EXECUTE 'CREATE EXTENSION timescaledb CASCADE';
  END IF;
END $$;`;
  return {
    up,
    // The existence check already makes the up replay-safe with no relation to guard on.
    guardedUp: up,
    // Inverse of CREATE EXTENSION. CASCADE because dependent objects exist; rarely run by
    // Prisma (it does not auto-apply downs) but provided for a complete reversible pair.
    down: `DROP EXTENSION IF EXISTS timescaledb CASCADE;`,
  };
}
