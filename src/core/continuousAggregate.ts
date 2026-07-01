// Continuous aggregate SQL builder (SPEC §2.3 / CLAUDE.md constraints 3, 4).
import type { CaggConfig, MigrationSql } from "./types.js";
import { assertInterval } from "./interval.js";
import { assertSafeIdent, qualifiedIdent, quoteIdent, quoteLiteral, relationLiteral } from "./sql.js";

const AGG_FNS = new Set(["avg", "sum", "min", "max", "count"]);

/**
 * Build the continuous aggregate create + optional refresh policy SQL.
 *
 * - `CREATE MATERIALIZED VIEW IF NOT EXISTS ... WITH (timescaledb.continuous) ... WITH NO DATA`
 *   (idempotent, constraint 3; data filled by the policy or a manual refresh).
 * - Optional `add_continuous_aggregate_policy(..., if_not_exists => TRUE)` when `refresh` set.
 * - `down` uses `DROP MATERIALIZED VIEW IF EXISTS` — never plain `DROP VIEW` (constraint 4).
 */
export function createContinuousAggregateSql(config: CaggConfig): MigrationSql {
  const { name, source, schema, sourceSchema, bucket, timeColumn, bucketColumn, aggregates, refresh, materializedOnly } = config;
  const groupBy = config.groupBy ?? [];

  assertSafeIdent(name, "continuous aggregate name");
  assertSafeIdent(source, "continuous aggregate source");
  assertSafeIdent(timeColumn, "time column");
  assertSafeIdent(bucketColumn, "bucket column");
  if (schema !== undefined) assertSafeIdent(schema, "continuous aggregate schema");
  if (sourceSchema !== undefined) assertSafeIdent(sourceSchema, "source schema");
  assertInterval(bucket);
  groupBy.forEach((g) => {
    assertSafeIdent(g.source, "groupBy source column");
    assertSafeIdent(g.output, "groupBy output column");
  });

  if (aggregates.length === 0) {
    throw new Error(`Continuous aggregate "${name}" must declare at least one aggregate.`);
  }
  for (const agg of aggregates) {
    if (!AGG_FNS.has(agg.fn)) {
      throw new Error(
        `Unsupported aggregate function ${JSON.stringify(agg.fn)} for "${agg.name}": expected one of ${[...AGG_FNS].join(", ")}.`,
      );
    }
    assertSafeIdent(agg.name, "aggregate result column");
    assertSafeIdent(agg.column, "aggregate source column");
  }

  // Reject duplicate output columns up front — CREATE MATERIALIZED VIEW would fail at deploy time
  // with a far less helpful "column specified more than once".
  const seenOutputs = new Set<string>([bucketColumn]);
  for (const output of [...groupBy.map((g) => g.output), ...aggregates.map((a) => a.name)]) {
    if (seenOutputs.has(output)) {
      throw new Error(
        `Continuous aggregate "${name}": output column ${JSON.stringify(output)} is declared more than once (the bucket column, groupBy outputs, and aggregate names must be distinct).`,
      );
    }
    seenOutputs.add(output);
  }

  // SELECT: time_bucket first, then group-by passthroughs, then the aggregates.
  const bucketExpr = `time_bucket(${quoteLiteral(bucket)}, ${quoteIdent(timeColumn)})`;
  const selectLines = [
    `${bucketExpr} AS ${quoteIdent(bucketColumn)}`,
    ...groupBy.map((g) => `${quoteIdent(g.source)} AS ${quoteIdent(g.output)}`),
    ...aggregates.map((a) => `${a.fn}(${quoteIdent(a.column)}) AS ${quoteIdent(a.name)}`),
  ];

  // Group by the bucket EXPRESSION and the SOURCE columns, never the output aliases: Postgres
  // resolves an unqualified GROUP BY name to an input column first, so an alias that matches a
  // real source-table column (e.g. a physical "bucket" column) would capture the GROUP BY and
  // fail the CREATE with "must appear in the GROUP BY clause".
  const groupByCols = [bucketExpr, ...groupBy.map((g) => quoteIdent(g.source))].join(", ");

  // `materialized_only` only emitted when set; omitted leaves TimescaleDB's default. `false` =
  // real-time aggregation. The relopt is a bare boolean (no quoting).
  const withOpts = ["timescaledb.continuous"];
  if (materializedOnly !== undefined) withOpts.push(`timescaledb.materialized_only = ${materializedOnly ? "true" : "false"}`);

  let up = `CREATE MATERIALIZED VIEW IF NOT EXISTS ${qualifiedIdent(name, schema)}
  WITH (${withOpts.join(", ")}) AS
SELECT
  ${selectLines.join(",\n  ")}
FROM ${qualifiedIdent(source, sourceSchema)}
GROUP BY ${groupByCols}
WITH NO DATA;`;

  if (refresh) {
    assertInterval(refresh.startOffset);
    assertInterval(refresh.endOffset);
    assertInterval(refresh.scheduleInterval);
    up += `

SELECT add_continuous_aggregate_policy(${relationLiteral(name, schema)},
  start_offset      => INTERVAL ${quoteLiteral(refresh.startOffset)},
  end_offset        => INTERVAL ${quoteLiteral(refresh.endOffset)},
  schedule_interval => INTERVAL ${quoteLiteral(refresh.scheduleInterval)},
  if_not_exists     => TRUE
);`;
  }

  // Constraint 4: a cagg appears in the views catalog but DROP VIEW errors on it.
  const down = `DROP MATERIALIZED VIEW IF EXISTS ${qualifiedIdent(name, schema)};`;

  return { up, down };
}
