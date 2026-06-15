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
 * Render a relation as a quoted *string literal* for TimescaleDB functions that take the
 * relation by name (e.g. create_hypertable, add_continuous_aggregate_policy,
 * refresh_continuous_aggregate). `SensorReading` -> `'"SensorReading"'`.
 *
 * CLAUDE.md constraint 2: NEVER cast (`::regclass` / `::name`) — pass the quoted string
 * literal. Mixed-case names must keep their inner quotes or Postgres case-folds them
 * (the `refresh_continuous_aggregate('sensorhourly')` failure surfaced in the spike).
 */
export function relationLiteral(name: string): string {
  return quoteLiteral(quoteIdent(name));
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
