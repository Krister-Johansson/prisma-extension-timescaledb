// Continuous aggregate SQL builder (SPEC §2.3 / CLAUDE.md constraints 3, 4).
import type { CaggConfig, MigrationSql } from "./types.js";
import { assertInterval } from "./interval.js";
import { assertSafeIdent, quoteIdent, quoteLiteral, relationLiteral } from "./sql.js";

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
  const { name, source, bucket, timeColumn, bucketColumn, aggregates, refresh } = config;
  const groupBy = config.groupBy ?? [];

  assertSafeIdent(name, "continuous aggregate name");
  assertSafeIdent(source, "continuous aggregate source");
  assertSafeIdent(timeColumn, "time column");
  assertSafeIdent(bucketColumn, "bucket column");
  assertInterval(bucket);
  groupBy.forEach((col) => assertSafeIdent(col, "groupBy column"));

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

  // SELECT: time_bucket first, then group-by passthroughs, then the aggregates.
  const selectLines = [
    `time_bucket(${quoteLiteral(bucket)}, ${quoteIdent(timeColumn)}) AS ${quoteIdent(bucketColumn)}`,
    ...groupBy.map((col) => `${quoteIdent(col)} AS ${quoteIdent(col)}`),
    ...aggregates.map((a) => `${a.fn}(${quoteIdent(a.column)}) AS ${quoteIdent(a.name)}`),
  ];

  const groupByCols = [bucketColumn, ...groupBy].map(quoteIdent).join(", ");

  let up = `CREATE MATERIALIZED VIEW IF NOT EXISTS ${quoteIdent(name)}
  WITH (timescaledb.continuous) AS
SELECT
  ${selectLines.join(",\n  ")}
FROM ${quoteIdent(source)}
GROUP BY ${groupByCols}
WITH NO DATA;`;

  if (refresh) {
    assertInterval(refresh.startOffset);
    assertInterval(refresh.endOffset);
    assertInterval(refresh.scheduleInterval);
    up += `

SELECT add_continuous_aggregate_policy(${relationLiteral(name)},
  start_offset      => INTERVAL ${quoteLiteral(refresh.startOffset)},
  end_offset        => INTERVAL ${quoteLiteral(refresh.endOffset)},
  schedule_interval => INTERVAL ${quoteLiteral(refresh.scheduleInterval)},
  if_not_exists     => TRUE
);`;
  }

  // Constraint 4: a cagg appears in the views catalog but DROP VIEW errors on it.
  const down = `DROP MATERIALIZED VIEW IF EXISTS ${quoteIdent(name)};`;

  return { up, down };
}
