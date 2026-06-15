// Extension setup SQL builder (SPEC §2.1 / CLAUDE.md constraint 1).
import type { MigrationSql } from "./types.js";

/**
 * Build the standalone, idempotent extension-setup migration. This must be emitted as its
 * own leading migration, before any table or hypertable DDL (CLAUDE.md constraint 1), and
 * is idempotent so `migrate reset` can replay it from scratch without error (constraint 3).
 */
export function createExtensionSql(): MigrationSql {
  return {
    up: `CREATE EXTENSION IF NOT EXISTS timescaledb CASCADE;`,
    // Inverse of CREATE EXTENSION. CASCADE because dependent objects exist; rarely run by
    // Prisma (it does not auto-apply downs) but provided for a complete reversible pair.
    down: `DROP EXTENSION IF EXISTS timescaledb CASCADE;`,
  };
}
