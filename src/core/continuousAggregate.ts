// Continuous aggregate SQL builder (SPEC §2.3 / CLAUDE.md constraints 3, 4).
import type { AggregateSpec, CaggConfig, MigrationSql, RefreshPolicy } from "./types.js";
import { assertInterval, intervalToMicroseconds, isWholeMonths, type Interval } from "./interval.js";
import { assertSafeIdent, qualifiedIdent, quoteIdent, quoteLiteral, relationLiteral, timescaleDoBlock } from "./sql.js";

/** The supported continuous-aggregate functions. Shared with the generator's annotation
 * validation (src/generator/dmmf.ts) so the two lists cannot drift. */
export const AGG_FNS: ReadonlySet<AggregateSpec["fn"]> = new Set(["avg", "sum", "min", "max", "count"] as const);

/**
 * Why a bucket width is unusable for time_bucket, as a sentence, or undefined when it is fine.
 * A fractional month ("1.5 months") is 1 month 15 days to Postgres, and time_bucket rejects
 * a month interval with a day or time component.
 */
export function bucketProblem(bucket: Interval): string | undefined {
  return isWholeMonths(bucket)
    ? undefined
    : `bucket ${JSON.stringify(bucket)} is a fractional number of months, which Postgres turns into months plus days; time_bucket rejects it.`;
}

/**
 * Why a refresh policy's window would be rejected by add_continuous_aggregate_policy, as a
 * sentence, or undefined when it is fine. start_offset must lie further back than end_offset,
 * and the window between them must hold at least two buckets ("policy refresh window too
 * small"). Calendar units have no fixed width, so a month-based value skips the arithmetic, and
 * so does the bucket check when the bucket is unknown (the runtime policy method).
 */
export function refreshWindowProblem(
  bucket: Interval | undefined,
  refresh: Pick<RefreshPolicy, "startOffset" | "endOffset">,
): string | undefined {
  const start = intervalToMicroseconds(refresh.startOffset);
  const end = intervalToMicroseconds(refresh.endOffset);
  if (start === undefined || end === undefined) return undefined;
  if (start <= end) {
    return `refresh startOffset ${JSON.stringify(refresh.startOffset)} must be further in the past than endOffset ${JSON.stringify(refresh.endOffset)}.`;
  }
  const width = bucket === undefined ? undefined : intervalToMicroseconds(bucket);
  if (width !== undefined && start - end < 2n * width) {
    return `the refresh window between startOffset ${JSON.stringify(refresh.startOffset)} and endOffset ${JSON.stringify(refresh.endOffset)} must span at least two buckets of ${JSON.stringify(bucket)}; TimescaleDB rejects a smaller window.`;
  }
  return undefined;
}

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
  const bucketIssue = bucketProblem(bucket);
  if (bucketIssue) throw new Error(`Continuous aggregate "${name}": ${bucketIssue}`);
  // The same relation as its source: CREATE ... IF NOT EXISTS would skip with a notice and the
  // policy call would then fail because the source is not a continuous aggregate.
  if (name === source && schema === sourceSchema) {
    throw new Error(`Continuous aggregate "${name}" cannot be named like its own source relation.`);
  }
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

  const create = `CREATE MATERIALIZED VIEW IF NOT EXISTS ${qualifiedIdent(name, schema)}
  WITH (${withOpts.join(", ")}) AS
SELECT
  ${selectLines.join(",\n  ")}
FROM ${qualifiedIdent(source, sourceSchema)}
GROUP BY ${groupByCols}
WITH NO DATA`;

  let policy: string | undefined;
  if (refresh) {
    assertInterval(refresh.startOffset);
    assertInterval(refresh.endOffset);
    assertInterval(refresh.scheduleInterval);
    const windowIssue = refreshWindowProblem(bucket, refresh);
    if (windowIssue) throw new Error(`Continuous aggregate "${name}": ${windowIssue}`);
    policy = `add_continuous_aggregate_policy(${relationLiteral(name, schema)},
  start_offset      => INTERVAL ${quoteLiteral(refresh.startOffset)},
  end_offset        => INTERVAL ${quoteLiteral(refresh.endOffset)},
  schedule_interval => INTERVAL ${quoteLiteral(refresh.scheduleInterval)},
  if_not_exists     => TRUE
)`;
  }

  // Both statements share one DO block that first puts TimescaleDB's schema on the search path.
  // The view body calls `time_bucket` and the policy `add_continuous_aggregate_policy`, both
  // emitted unqualified, and Prisma runs migrations with `search_path` set to the datasource
  // schema alone (issue #129). The extension schema is APPENDED, so an unqualified view name
  // still lands in the caller's own schema. CREATE MATERIALIZED VIEW inside a DO block verified
  // empirically on 2.27.2.
  const body =
    `  ${create.replace(/\n/g, "\n  ")};` + (policy ? `\n  PERFORM ${policy.replace(/\n/g, "\n  ")};` : "");

  const up = timescaleDoBlock(body);

  // Guarded form for emitted migrations: skip when the SOURCE relation no longer exists (a
  // later Prisma migration dropped the hypertable, or an earlier guarded block skipped the
  // parent cagg).
  const guardedUp = timescaleDoBlock(body, relationLiteral(source, sourceSchema));

  // Constraint 4: a cagg appears in the views catalog but DROP VIEW errors on it.
  const down = `DROP MATERIALIZED VIEW IF EXISTS ${qualifiedIdent(name, schema)};`;

  return { up, down, guardedUp };
}
