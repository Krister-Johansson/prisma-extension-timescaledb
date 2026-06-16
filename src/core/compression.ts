// Columnstore-compression policy SQL builder (TimescaleDB hypercore; BUILD_PLAN stretch;
// CLAUDE.md constraints 2, 3).
//
// Unlike retention, enabling compression is TWO steps and uses the modern *columnstore* API:
//   1. ALTER TABLE <rel> SET (timescaledb.enable_columnstore = true, segmentby = ..., orderby = ...)
//   2. CALL add_columnstore_policy(<rel>, after => INTERVAL '...', if_not_exists => TRUE)
// `add_columnstore_policy` is a PROCEDURE (needs CALL, not SELECT) and errors if the columnstore
// is not enabled first — both facts verified empirically against timescale/timescaledb:2.27.2.
// It is transaction-safe, so the two statements run fine inside Prisma's migration transaction.
import type { CompressionConfig, CompressionOrderBy, MigrationSql } from "./types.js";
import { assertInterval } from "./interval.js";
import { assertSafeIdent, quoteIdent, quoteLiteral, qualifiedIdent, relationLiteral } from "./sql.js";

/** Compression-policy builder input. All names are DB names (post-@@map / @@schema). */
export interface CompressionPolicyConfig extends CompressionConfig {
  /** Hypertable relation name as it exists in the DB, unquoted. */
  table: string;
  /** Database schema (@@schema) when using multiSchema; omitted for the default schema. */
  schema?: string;
}

/**
 * Parse a columnstore `orderby` term such as `"time DESC NULLS LAST"` into its parts. The column
 * is left as written (a Prisma field name from an annotation / runtime arg; the caller maps it to
 * the DB name). Throws on malformed direction / NULLS tokens. Shared by the generator (annotation
 * parsing) and the runtime ($timescale.addCompressionPolicy).
 */
export function parseOrderByTerm(term: string): CompressionOrderBy {
  const tokens = term.trim().split(/\s+/);
  const column = tokens[0];
  if (column === undefined || column === "") {
    throw new Error(`Invalid orderBy term ${JSON.stringify(term)}: missing a column.`);
  }
  const result: CompressionOrderBy = { column };
  let i = 1;
  const dir = tokens[i]?.toLowerCase();
  if (dir === "asc" || dir === "desc") {
    result.direction = dir;
    i++;
  }
  if (tokens[i]?.toLowerCase() === "nulls") {
    const nulls = tokens[i + 1]?.toLowerCase();
    if (nulls !== "first" && nulls !== "last") {
      throw new Error(`Invalid orderBy term ${JSON.stringify(term)}: expected NULLS FIRST | NULLS LAST.`);
    }
    result.nulls = nulls;
    i += 2;
  }
  if (i < tokens.length) {
    throw new Error(`Invalid orderBy term ${JSON.stringify(term)}: unexpected ${JSON.stringify(tokens.slice(i).join(" "))}.`);
  }
  return result;
}

/**
 * Build the columnstore reloption assignments for an `ALTER TABLE ... SET (...)`. Always begins
 * with `timescaledb.enable_columnstore = true` (the policy errors without it), then the optional
 * `segmentby` / `orderby`. Column names (DB names) are validated and quoted to preserve case;
 * the whole comma-joined list is wrapped as a single SQL string literal, as the reloption expects.
 */
export function columnstoreReloptions(
  segmentBy?: readonly string[],
  orderBy?: readonly CompressionOrderBy[],
): string[] {
  const opts = ["timescaledb.enable_columnstore = true"];
  if (segmentBy && segmentBy.length > 0) {
    for (const col of segmentBy) assertSafeIdent(col, "compression segmentBy column");
    opts.push(`timescaledb.segmentby = ${quoteLiteral(segmentBy.map(quoteIdent).join(", "))}`);
  }
  if (orderBy && orderBy.length > 0) {
    opts.push(`timescaledb.orderby = ${quoteLiteral(orderBy.map(renderOrderByTerm).join(", "))}`);
  }
  return opts;
}

/**
 * Render one orderby term to `"col" [ASC|DESC] [NULLS FIRST|LAST]` (DB column name). Validates the
 * direction / nulls so an invalid object-form input (a JS caller bypassing the types) fails fast
 * instead of silently coercing to ASC / NULLS LAST.
 */
function renderOrderByTerm(o: CompressionOrderBy): string {
  assertSafeIdent(o.column, "compression orderBy column");
  let term = quoteIdent(o.column);
  if (o.direction) {
    if (o.direction !== "asc" && o.direction !== "desc") {
      throw new Error(`Invalid orderBy direction ${JSON.stringify(o.direction)} for column "${o.column}": expected "asc" or "desc".`);
    }
    term += o.direction === "desc" ? " DESC" : " ASC";
  }
  if (o.nulls) {
    if (o.nulls !== "first" && o.nulls !== "last") {
      throw new Error(`Invalid orderBy nulls ${JSON.stringify(o.nulls)} for column "${o.column}": expected "first" or "last".`);
    }
    term += o.nulls === "first" ? " NULLS FIRST" : " NULLS LAST";
  }
  return term;
}

/**
 * Build the reset-safe compression SQL: enable the columnstore (with `segmentBy`/`orderBy`) and
 * add an `add_columnstore_policy` that converts chunks older than `after`.
 *
 * - The `ALTER TABLE` target is a quoted (schema-qualified) *identifier*; the policy relation is a
 *   quoted string *literal* `'"Table"'` — NO `::regclass` (constraint 2), same lesson as
 *   `create_hypertable`.
 * - `if_not_exists => TRUE` makes replay safe (constraint 3): on `migrate reset` an identical
 *   policy is a no-op, and re-running the `ALTER TABLE` only re-applies settings (a NOTICE). NB:
 *   like retention, TimescaleDB will NOT update an existing policy whose `after` differs, and
 *   changing `segmentBy`/`orderBy` only affects *future* compressions — change needs a remove + re-add.
 *
 * Down: `remove_columnstore_policy(..., if_exists => TRUE)`. It intentionally does NOT disable the
 * columnstore — `SET (enable_columnstore = false)` fails once any chunk is compressed, so leaving
 * the columnstore enabled (just unscheduled) is the safe inverse (mirrors retention's down).
 */
export function createCompressionPolicySql(config: CompressionPolicyConfig): MigrationSql {
  const { table, schema, after, segmentBy, orderBy } = config;

  assertSafeIdent(table, "compression table");
  if (schema !== undefined) assertSafeIdent(schema, "compression schema");
  assertInterval(after);

  const reloptions = columnstoreReloptions(segmentBy, orderBy);
  const rel = relationLiteral(table, schema);
  const alterTarget = qualifiedIdent(table, schema);

  const up = `ALTER TABLE ${alterTarget} SET (
  ${reloptions.join(",\n  ")}
);
CALL add_columnstore_policy(${rel}, after => INTERVAL ${quoteLiteral(after)}, if_not_exists => TRUE);`;

  const down = `CALL remove_columnstore_policy(${rel}, if_exists => TRUE);`;

  return { up, down };
}
