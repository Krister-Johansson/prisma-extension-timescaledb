// Chunk-skipping SQL builder (TimescaleDB `enable_chunk_skipping`; CLAUDE.md constraints 2, 3).
//
// Chunk skipping records per-chunk min/max range stats for a secondary (non-partitioning) column
// when chunks are compressed, letting the planner exclude whole chunks that can't match a filter
// on that column. Two facts, both verified empirically against timescale/timescaledb:2.27.2,
// shape this builder:
//   1. `enable_chunk_skipping(rel, col)` is only callable when the session GUC
//      `timescaledb.enable_chunk_skipping` is `on` (it is `PGC_USERSET`, so settable per-session).
//   2. The same GUC must also be `on` at QUERY time for the planner to actually skip, and skipping
//      only helps COMPRESSED chunks — both are the user's runtime concern, documented in the README;
//      this migration only registers the column.
// Wrapping `SET LOCAL <guc> = on` + the `enable_chunk_skipping` calls in ONE `DO` block keeps it
// self-contained: the block runs atomically (its own implicit transaction when none is active), so
// the GUC is reliably on for the calls whether or not Prisma wraps the migration in a transaction.
import type { MigrationSql } from "./types.js";
import { assertSafeIdent, quoteLiteral, relationLiteral } from "./sql.js";

/** Chunk-skipping builder input. All names are DB names (post-@@map / @@schema). */
export interface ChunkSkippingConfig {
  /** Hypertable relation name as it exists in the DB, unquoted. */
  table: string;
  /** Database schema (@@schema) when using multiSchema; omitted for the default schema. */
  schema?: string;
  /** Secondary columns (DB names) to enable chunk skipping on. Must be non-empty. */
  columns: readonly string[];
}

/**
 * Build the reset-safe chunk-skipping SQL: a single `DO` block that turns the
 * `timescaledb.enable_chunk_skipping` GUC on (`SET LOCAL`, scoped to the block) and then calls
 * `enable_chunk_skipping(rel, col, if_not_exists => TRUE)` for every column.
 *
 * - The relation is a quoted string *literal* `'"Table"'` — NO `::regclass` / `::name` cast
 *   (constraint 2), same lesson as `create_hypertable`.
 * - `if_not_exists => TRUE` makes replay safe (constraint 3): on `migrate reset` re-enabling an
 *   already-registered column is a NOTICE, not an error.
 *
 * Down: dropping the table (Prisma's own down) removes its chunk-skipping settings, so there is no
 * separate `disable_chunk_skipping` step (mirrors `create_hypertable`).
 */
export function createChunkSkippingSql(config: ChunkSkippingConfig): MigrationSql {
  const { table, schema, columns } = config;

  assertSafeIdent(table, "chunk-skipping table");
  if (schema !== undefined) assertSafeIdent(schema, "chunk-skipping schema");
  if (columns.length === 0) {
    throw new Error("createChunkSkippingSql: at least one column is required.");
  }
  for (const col of columns) assertSafeIdent(col, "chunk-skipping column");

  const rel = relationLiteral(table, schema);
  const performs = columns
    .map((col) => `  PERFORM enable_chunk_skipping(${rel}, ${quoteLiteral(col)}, if_not_exists => TRUE);`)
    .join("\n");

  const up = `DO $$ BEGIN
  SET LOCAL timescaledb.enable_chunk_skipping = on;
${performs}
END $$;`;

  const down = `-- No separate disable step: dropping "${table}" (Prisma's own down) removes its chunk-skipping settings.`;

  return { up, down };
}
