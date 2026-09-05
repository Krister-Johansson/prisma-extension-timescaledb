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
 * block expect it, and the leading existence check leaves an extension that already lives
 * elsewhere alone.
 *
 * The branches cover a database whose `public` schema was dropped. The bare form then installs
 * into whatever the search path names, which works once that schema exists. When nothing on the
 * search path exists yet, this migration cannot succeed at all: it runs before the migration
 * that creates the schema, and creating someone's datasource schema is Prisma's job, not this
 * package's. The explicit `RAISE` says so, instead of leaving PostgreSQL's `no schema has been
 * selected to create in` for the user to decode.
 *
 * The `EXCEPTION` clause covers a second session installing the extension between the existence
 * check and the `CREATE`. Prisma's migration engine takes an advisory lock that serializes its
 * own runs, but `createExtensionSql()` is public API for hand-written migrations, and
 * `PRISMA_SCHEMA_DISABLE_ADVISORY_LOCK` turns Prisma's lock off. Swallowing the two SQLSTATEs a
 * lost race produces covers every concurrent creator, including one that never took a lock of
 * ours; `CREATE EXTENSION IF NOT EXISTS` is check-then-act too and does not.
 */
export function createExtensionSql(): MigrationSql {
  const up = `DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'timescaledb') THEN RETURN; END IF;
  IF to_regnamespace('public') IS NOT NULL THEN
    EXECUTE 'CREATE EXTENSION timescaledb WITH SCHEMA public CASCADE';
  ELSIF current_schema() IS NOT NULL THEN
    EXECUTE 'CREATE EXTENSION timescaledb CASCADE';
  ELSE
    RAISE EXCEPTION 'prisma-extension-timescaledb: cannot install the timescaledb extension. No schema on the search path (%) exists, and this migration runs before the one that creates it. Create the schema first, or install the extension yourself with CREATE EXTENSION timescaledb.', current_setting('search_path');
  END IF;
EXCEPTION
  -- Another session installed it between the check above and the CREATE.
  WHEN duplicate_object OR unique_violation THEN NULL;
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
