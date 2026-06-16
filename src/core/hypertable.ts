// Hypertable conversion SQL builder (SPEC §2.2 / CLAUDE.md constraints 2, 3, 6).
import type { HypertableConfig, MigrationSql } from "./types.js";
import { assertInterval } from "./interval.js";
import { assertSafeIdent, quoteLiteral, relationLiteral } from "./sql.js";

const DEFAULT_CHUNK_INTERVAL = "7 days";

/**
 * Build the cast-free, idempotent `create_hypertable(...)` conversion SQL.
 *
 * - Relation passed as a quoted string literal `'"Table"'` — NO `::regclass` / `::name`
 *   (constraint 2): those fail inside Prisma's migration engine.
 * - `by_range(...)` is the modern dimension builder; the interval comes from `chunkInterval`
 *   (default `"7 days"`).
 * - `if_not_exists => TRUE, migrate_data => TRUE` make replay safe (constraints 3, 6).
 *
 * Down: dropping the table (Prisma's own down) removes the hypertable, so there is no
 * separate "un-hypertable" step (SPEC §2.2).
 */
export function createHypertableSql(config: HypertableConfig): MigrationSql {
  const { table, column, schema } = config;
  const chunkInterval = config.chunkInterval ?? DEFAULT_CHUNK_INTERVAL;

  assertSafeIdent(table, "hypertable table");
  assertSafeIdent(column, "hypertable time column");
  if (schema !== undefined) assertSafeIdent(schema, "hypertable schema");
  assertInterval(chunkInterval);

  const up = `SELECT create_hypertable(
  ${relationLiteral(table, schema)},
  by_range(${quoteLiteral(column)}, INTERVAL ${quoteLiteral(chunkInterval)}),
  if_not_exists => TRUE,
  migrate_data  => TRUE
);`;

  const down = `-- No separate un-hypertable step: dropping "${table}" (Prisma's own down) removes the hypertable.`;

  return { up, down };
}
