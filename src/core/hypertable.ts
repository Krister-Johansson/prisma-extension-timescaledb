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
  const { table, column, schema, spacePartition } = config;
  const chunkInterval = config.chunkInterval ?? DEFAULT_CHUNK_INTERVAL;

  assertSafeIdent(table, "hypertable table");
  assertSafeIdent(column, "hypertable time column");
  if (schema !== undefined) assertSafeIdent(schema, "hypertable schema");
  assertInterval(chunkInterval);

  const rel = relationLiteral(table, schema);
  let up = `SELECT create_hypertable(
  ${rel},
  by_range(${quoteLiteral(column)}, INTERVAL ${quoteLiteral(chunkInterval)}),
  if_not_exists => TRUE,
  migrate_data  => TRUE
);`;

  // Optional hash space dimension: a second partitioning dimension on `column`, added AFTER the
  // hypertable exists. The column name is a string literal (NAME) — preserves case, no cast — and
  // `if_not_exists => TRUE` makes replay a no-op (constraint 3). Verified transaction-safe.
  if (spacePartition) {
    assertSafeIdent(spacePartition.column, "space partition column");
    if (!Number.isInteger(spacePartition.partitions) || spacePartition.partitions < 1) {
      throw new Error(
        `createHypertableSql: spacePartition.partitions must be a positive integer (got ${JSON.stringify(spacePartition.partitions)}).`,
      );
    }
    up += `\nSELECT add_dimension(${rel}, by_hash(${quoteLiteral(spacePartition.column)}, ${spacePartition.partitions}), if_not_exists => TRUE);`;
  }

  const down = `-- No separate un-hypertable step: dropping "${table}" (Prisma's own down) removes the hypertable.`;

  return { up, down };
}
