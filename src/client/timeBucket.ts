// model.timeBucket(...) — typed args + result inference (SPEC §4.1) and the runtime SQL
// builder. The result row type is inferred from the `aggregate` spec and `groupBy` list;
// bad aggregate columns and a missing `range` fail to compile.
import { Prisma } from "@prisma/client/extension";
import type { Interval } from "../core/interval.js";
import { assertInterval } from "../core/interval.js";
import { assertSafeIdent, quoteIdent } from "../core/sql.js";
import { whereToSql } from "./where.js";

// --- type machinery --------------------------------------------------------

/** The scalar row of a model delegate `T` (e.g. `{ time: Date; deviceId: number }`). */
export type ScalarRow<T> = Prisma.Result<T, Record<string, never>, "findFirstOrThrow">;

/** The model's `where` input, reused from Prisma (SPEC §4.1). */
export type WhereInput<T> = Prisma.Args<T, "findMany">["where"];

type Prettify<T> = { [K in keyof T]: T[K] } & {};

/** Scalar columns of `R` whose type is numeric (valid targets for avg/sum/min/max). */
type NumericColumn<R> = { [K in keyof R]-?: NonNullable<R[K]> extends number ? K : never }[keyof R] & string;
/** Any scalar column name of `R` (valid target for count / groupBy). */
type AnyColumn<R> = Extract<keyof R, string>;

/** A single aggregate operation: one function applied to one column of `R`. */
export type AggregateOp<R> =
  | { avg: NumericColumn<R> }
  | { sum: NumericColumn<R> }
  | { min: NumericColumn<R> }
  | { max: NumericColumn<R> }
  | { count: AnyColumn<R> };

/** The `aggregate` spec: result-column name -> aggregate operation. */
export type AggregateInput<R> = Record<string, AggregateOp<R>>;

/** Arguments to `timeBucket`. `R` is the model's scalar row, `W` its where input. */
export interface TimeBucketArgs<R, W = unknown> {
  /** time_bucket interval, e.g. "1 hour". */
  bucket: Interval;
  /** Required time range (both bounds) — typing forces callers to bound the scan. */
  range: { start: Date; end: Date };
  /** Optional filter (v0.1 runtime: top-level equality only). */
  where?: W;
  /** Optional group-by columns (besides the bucket). */
  groupBy?: ReadonlyArray<AnyColumn<R>>;
  /** One or more aggregates; keys become result columns. */
  aggregate: AggregateInput<R>;
}

type GroupByOf<A> = A extends { groupBy: ReadonlyArray<infer G> } ? G : never;

/** The inferred result row: bucket + selected group-by columns + each aggregate (as number). */
export type TimeBucketRow<R, A extends TimeBucketArgs<R, unknown>> = Prettify<
  { bucket: Date } & { [K in Extract<GroupByOf<A>, keyof R>]: R[K] } & {
    // -readonly: `const A` marks the aggregate keys readonly; the result row shouldn't be.
    -readonly [K in keyof A["aggregate"]]: number;
  }
>;

/** The generic call signature installed on every model as `.timeBucket(...)`. */
export interface TimeBucketMethod {
  <T, const A extends TimeBucketArgs<ScalarRow<T>, WhereInput<T>>>(
    this: T,
    args: A,
  ): Promise<Array<TimeBucketRow<ScalarRow<T>, A>>>;
}

// --- runtime SQL builder ---------------------------------------------------

const AGG_FNS = new Set(["avg", "sum", "min", "max", "count"]);

/** Loose runtime view of the args (the precise types live in TimeBucketMethod). */
export interface TimeBucketRuntimeArgs {
  bucket: string;
  range: { start: Date; end: Date };
  where?: Record<string, unknown>;
  groupBy?: readonly string[];
  aggregate: Record<string, Record<string, string>>;
}

/**
 * Build the parameterized time_bucket query. Identifiers are quoted; values are $-params.
 * `columns` maps Prisma field names (used in args) to DB column names (@map); output columns
 * keep the Prisma field names so the inferred result row shape is unchanged.
 */
export function buildTimeBucketQuery(
  table: string,
  timeColumn: string,
  args: TimeBucketRuntimeArgs,
  columns: Record<string, string> = {},
): { sql: string; params: unknown[] } {
  assertSafeIdent(table, "model table");
  assertSafeIdent(timeColumn, "time column");
  assertInterval(args.bucket);
  if (!args.range || !(args.range.start instanceof Date) || !(args.range.end instanceof Date)) {
    throw new Error("timeBucket: `range.start` and `range.end` are required Dates.");
  }

  // Resolve a Prisma field name to its DB column name (identity when not @map-renamed).
  const col = (name: string): string => {
    const dbName = columns[name] ?? name;
    assertSafeIdent(dbName, "column");
    return dbName;
  };

  const params: unknown[] = [args.bucket, args.range.start, args.range.end];
  const time = quoteIdent(timeColumn);

  const select: string[] = [`time_bucket($1, ${time}) AS "bucket"`];

  const groupCols = args.groupBy ?? [];
  for (const g of groupCols) {
    assertSafeIdent(g, "groupBy column");
    select.push(`${quoteIdent(col(g))} AS ${quoteIdent(g)}`);
  }

  const aggregateEntries = Object.entries(args.aggregate ?? {});
  if (aggregateEntries.length === 0) {
    throw new Error("timeBucket: at least one aggregate is required.");
  }
  for (const [resultName, op] of aggregateEntries) {
    assertSafeIdent(resultName, "aggregate result column");
    const entry = Object.entries(op)[0];
    if (!entry) throw new Error(`timeBucket: aggregate "${resultName}" must specify a function.`);
    const [fn, column] = entry;
    if (!AGG_FNS.has(fn)) {
      throw new Error(`timeBucket: unsupported aggregate function "${fn}" for "${resultName}".`);
    }
    const src = quoteIdent(col(column));
    const alias = quoteIdent(resultName);
    // Cast so results come back as JS numbers (matching the typed `number` result), instead
    // of Prisma's BigInt/Decimal for integer-column aggregates:
    //   count -> ::int        (Postgres count is bigint)
    //   sum/avg -> ::float8    (sum of int is bigint; avg of int is numeric)
    // min/max already return the column's own (numeric) type. NB: float8 means sums beyond
    // 2^53 lose exactness — acceptable for the `number` contract.
    if (fn === "count") {
      select.push(`count(${src})::int AS ${alias}`);
    } else if (fn === "sum" || fn === "avg") {
      select.push(`${fn}(${src})::double precision AS ${alias}`);
    } else {
      select.push(`${fn}(${src}) AS ${alias}`);
    }
  }

  let where = `${time} >= $2 AND ${time} < $3`;
  const whereSql = whereToSql(args.where, {
    col: (name) => quoteIdent(col(name)),
    push: (value) => {
      params.push(value);
      return `$${params.length}`;
    },
  });
  if (whereSql) where += ` AND (${whereSql})`;

  const groupBy = [`"bucket"`, ...groupCols.map((g) => quoteIdent(g))].join(", ");
  const sql = `SELECT ${select.join(", ")} FROM ${quoteIdent(table)} WHERE ${where} GROUP BY ${groupBy} ORDER BY "bucket"`;
  return { sql, params };
}
