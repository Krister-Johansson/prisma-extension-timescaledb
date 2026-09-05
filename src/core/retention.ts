// Retention policy SQL builder (BUILD_PLAN stretch; CLAUDE.md constraints 2, 3).
import type { MigrationSql } from "./types.js";
import type { Interval } from "./interval.js";
import { assertInterval } from "./interval.js";
import { assertSafeIdent, quoteLiteral, relationLiteral, timescaleDoBlock } from "./sql.js";

/** Retention-policy builder input. All names are DB names (post-@@map / @@schema). */
export interface RetentionPolicyConfig {
  /** Hypertable relation name as it exists in the DB, unquoted. */
  table: string;
  /** Database schema (@@schema) when using multiSchema; omitted for the default schema. */
  schema?: string;
  /** Drop chunks whose data is older than this interval (TimescaleDB `drop_after`). */
  dropAfter: Interval;
}

/**
 * Build the reset-safe `add_retention_policy(...)` SQL — drops chunks older than `dropAfter`.
 *
 * - Relation passed as a quoted string literal `'"Table"'` — NO `::regclass` (constraint 2);
 *   the cast form fails inside Prisma's migration engine (same lesson as `create_hypertable`).
 * - `if_not_exists => TRUE` makes replay safe (constraint 3): on `migrate reset` an identical
 *   policy is a NOTICE/no-op. NB: TimescaleDB will NOT update an existing policy whose
 *   `drop_after` differs — it warns and keeps the old one — so changing `dropAfter` needs a
 *   remove + re-add, not just a regenerate.
 *
 * Down: `remove_retention_policy(..., if_exists => TRUE)` (idempotent).
 */
export function createRetentionPolicySql(config: RetentionPolicyConfig): MigrationSql {
  const { table, schema, dropAfter } = config;

  assertSafeIdent(table, "retention table");
  if (schema !== undefined) assertSafeIdent(schema, "retention schema");
  assertInterval(dropAfter);

  const rel = relationLiteral(table, schema);
  const call = `add_retention_policy(${rel}, drop_after => INTERVAL ${quoteLiteral(dropAfter)}, if_not_exists => TRUE)`;
  // Wrapped in a DO block that first puts TimescaleDB's schema on the search path:
  // `add_retention_policy` is emitted unqualified and Prisma runs migrations with `search_path`
  // set to the datasource schema alone (issue #129).
  const up = timescaleDoBlock(`  PERFORM ${call};`);
  // Guarded form for emitted migrations: a later-dropped table makes replay skip, not fail.
  const guardedUp = timescaleDoBlock(`  PERFORM ${call};`, rel);
  const down = timescaleDoBlock(`  PERFORM remove_retention_policy(${rel}, if_exists => TRUE);`);

  return { up, down, guardedUp };
}
