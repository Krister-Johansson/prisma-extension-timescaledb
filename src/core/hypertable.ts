// Hypertable conversion SQL builder (SPEC §2.2 / CLAUDE.md constraints 2, 3, 6).
import type { HypertableConfig, MigrationSql } from "./types.js";
import { assertInterval } from "./interval.js";
import { assertSafeIdent, quoteLiteral, relationLiteral, timescaleDoBlock } from "./sql.js";

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
  const convert = `create_hypertable(
  ${rel},
  by_range(${quoteLiteral(column)}, INTERVAL ${quoteLiteral(chunkInterval)}),
  if_not_exists => TRUE,
  migrate_data  => TRUE
)`;

  // Optional hash space dimension: a second partitioning dimension on `column`, added AFTER the
  // hypertable exists. The column name is a string literal (NAME) — preserves case, no cast — and
  // `if_not_exists => TRUE` makes replay a no-op (constraint 3). Verified transaction-safe.
  let dimension: string | undefined;
  if (spacePartition) {
    assertSafeIdent(spacePartition.column, "space partition column");
    if (!Number.isInteger(spacePartition.partitions) || spacePartition.partitions < 1) {
      throw new Error(
        `createHypertableSql: spacePartition.partitions must be a positive integer (got ${JSON.stringify(spacePartition.partitions)}).`,
      );
    }
    dimension = `add_dimension(${rel}, by_hash(${quoteLiteral(spacePartition.column)}, ${spacePartition.partitions}), if_not_exists => TRUE)`;
  }

  // Every statement runs inside a DO block that first puts TimescaleDB's schema on the search
  // path: `create_hypertable` / `by_range` / `set_partitioning_interval` are emitted unqualified
  // and Prisma runs migrations with `search_path` set to the datasource schema alone, so on a
  // project outside `public` they would otherwise be unresolvable (issue #129).
  //
  // set_partitioning_interval re-asserts the chunk interval every apply: create_hypertable's
  // if_not_exists never updates a LIVE hypertable's interval, so without it a changed
  // chunkInterval would silently keep the old chunk size (a no-op when already equal).
  const body =
    `  PERFORM ${indentBody(convert)};` +
    (dimension ? `\n  PERFORM ${dimension};` : "") +
    `\n  PERFORM set_partitioning_interval(${rel}, INTERVAL ${quoteLiteral(chunkInterval)});`;

  const up = timescaleDoBlock(body);

  // Guarded form: skip when the table no longer exists (a later Prisma migration dropped it),
  // so an old migration snapshot replays cleanly on `migrate reset` — verified empirically
  // (PERFORM create_hypertable inside DO works; the guard skips on a missing relation).
  const guardedUp = timescaleDoBlock(body, rel);

  const down = `-- No separate un-hypertable step: dropping "${table}" (Prisma's own down) removes the hypertable.`;

  return { up, down, guardedUp };
}

/** Re-indent a multi-line call expression by two spaces for embedding in a DO body. */
function indentBody(sql: string): string {
  return sql.replace(/\n/g, "\n  ");
}
