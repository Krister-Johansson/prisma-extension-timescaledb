// SQL string helpers shared by the builders. Centralized so quoting/escaping is consistent
// and the "no cast" / "quoted relation literal" rules from CLAUDE.md are enforced in one place.

const SAFE_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Quote a SQL identifier (table/column/view name), preserving case and escaping embedded
 * double quotes by doubling them. `SensorReading` -> `"SensorReading"`.
 */
export function quoteIdent(name: string): string {
  if (name.length === 0) {
    throw new Error("Identifier must not be empty");
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Quote a SQL string literal, escaping embedded single quotes by doubling them.
 * `1 hour` -> `'1 hour'`.
 */
export function quoteLiteral(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Quote a (optionally schema-qualified) relation/identifier for use in DDL/queries.
 * `qualifiedIdent("sensor_readings", "metrics")` -> `"metrics"."sensor_readings"`;
 * with no schema -> `"sensor_readings"`.
 */
export function qualifiedIdent(name: string, schema?: string): string {
  return schema ? `${quoteIdent(schema)}.${quoteIdent(name)}` : quoteIdent(name);
}

/**
 * Render a relation as a quoted *string literal* for TimescaleDB functions that take the
 * relation by name (e.g. create_hypertable, add_continuous_aggregate_policy,
 * refresh_continuous_aggregate). `SensorReading` -> `'"SensorReading"'`;
 * with a schema -> `'"metrics"."sensor_readings"'`.
 *
 * CLAUDE.md constraint 2: NEVER cast (`::regclass` / `::name`) — pass the quoted string
 * literal. Mixed-case names must keep their inner quotes or Postgres case-folds them
 * (the `refresh_continuous_aggregate('sensorhourly')` failure surfaced in the spike).
 */
export function relationLiteral(name: string, schema?: string): string {
  return quoteLiteral(qualifiedIdent(name, schema));
}

/**
 * Assert a plain SQL identifier (used where double-quote escaping is not enough on its own,
 * e.g. to reject obviously bogus input early with a clear message).
 */
export function assertSafeIdent(name: string, label = "identifier"): void {
  if (!SAFE_IDENT.test(name)) {
    throw new Error(
      `Invalid ${label} ${JSON.stringify(name)}: expected letters, digits and underscores, starting with a letter or underscore.`,
    );
  }
}

/**
 * The existence guard opening every emitted objects DO block: skip (with a visible WARNING,
 * never silently) when the target relation does not exist. On a `migrate reset` replay that
 * is the normal dropped-later case; at first deploy it flags a missing CREATE TABLE
 * migration, which the unguarded form would have surfaced as a hard error.
 */
export function existenceGuard(rel: string): string {
  return `IF to_regclass(${rel}) IS NULL THEN RAISE WARNING 'prisma-extension-timescaledb: relation % does not exist; skipping (table dropped by a later migration, or its CREATE TABLE migration is missing)', ${rel}; RETURN; END IF;`;
}

/**
 * The plpgsql lines that put TimescaleDB's own schema on the search path for the rest of a
 * `DO` block. Emitted SQL calls `create_hypertable`, `by_range`, `time_bucket` and friends
 * unqualified, and Prisma runs migrations with `search_path` set to the datasource schema
 * alone (`?schema=data_collection`). TimescaleDB installs into `public` (or wherever
 * `CREATE EXTENSION` put it), so on a project whose tables live outside `public` those
 * functions are unresolvable and `migrate deploy` fails with
 * `function by_range(unknown, interval) does not exist` (issue #129).
 *
 * The path is APPENDED, never replaced, so unqualified relation names in the same block still
 * resolve to the caller's schema first. `concat_ws` skips NULLs, so a missing extension leaves
 * the search path untouched instead of resetting it, and an empty search path yields the
 * extension schema alone. `set_config(..., is_local => true)` scopes the change to the
 * surrounding transaction, which for a `DO` block with no explicit transaction is the block.
 */
const SEARCH_PATH_LINES = `SELECT n.nspname INTO ts_schema
    FROM pg_extension e JOIN pg_namespace n ON n.oid = e.extnamespace
   WHERE e.extname = 'timescaledb';
  PERFORM set_config('search_path', concat_ws(', ', nullif(current_setting('search_path'), ''), quote_ident(ts_schema)), true);`;

/**
 * Wrap statements in the standard emitted `DO` block: declare the extension-schema variable,
 * optionally skip when `guardRel` no longer exists, then extend the search path (see
 * SEARCH_PATH_LINES) before running `body`.
 *
 * The existence guard comes FIRST so its `RETURN` cannot leave a half-applied search path, and
 * because `to_regclass` is a `pg_catalog` builtin that needs no search-path help.
 *
 * @param body plpgsql statements, each already terminated with `;`, indented by two spaces.
 * @param guardRel quoted relation literal to guard on; omitted for an unguarded block.
 */
export function timescaleDoBlock(body: string, guardRel?: string): string {
  const guard = guardRel === undefined ? "" : `${existenceGuard(guardRel)}\n  `;
  return `DO $$
DECLARE ts_schema text;
BEGIN
  ${guard}${SEARCH_PATH_LINES}
${body}
END $$;`;
}
