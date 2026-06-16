// model.timeBucket(...) — typed args + result inference (SPEC §4.1) and the runtime SQL
// builder. The result row type is inferred from the `aggregate` spec and `groupBy` list;
// bad aggregate columns and a missing `range` fail to compile.
import { Prisma } from "@prisma/client/extension";
import type { Interval } from "../core/interval.js";
import { assertInterval } from "../core/interval.js";
import type { RelationConfig } from "../core/types.js";
import { assertSafeIdent, qualifiedIdent, quoteIdent } from "../core/sql.js";
import { whereToSql, type RuntimeRelation } from "./where.js";

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

/**
 * Exact-output selector for an aggregate result column. By default results come back as a JS
 * `number` (sum/avg are cast to `double precision`, so magnitudes past 2^53 lose precision).
 * Opt into an exact type per aggregate:
 *  - `"bigint"` -> a native JS `bigint` (Postgres `::bigint`): exact integers, and avoids the
 *    `count` overflow that the default `::int` hits past ~2.1B rows in a single bucket.
 *  - `"string"` -> the exact decimal as a JS `string` (Postgres `::text`): exact for `avg` and
 *    large fractional sums, JSON-safe, and free of any Prisma-internal type coupling.
 * Restricted per function: `avg` can't be `"bigint"` (it is fractional); `count` can't be
 * `"string"` (it is an integer count).
 */
export type SumAs = "number" | "bigint" | "string";
export type AvgAs = "number" | "string";
export type CountAs = "number" | "bigint";

/** A single aggregate operation: one function applied to one column of `R` (+ optional `as`). */
export type AggregateOp<R> =
  | { sum: NumericColumn<R>; as?: SumAs }
  | { avg: NumericColumn<R>; as?: AvgAs }
  | { min: NumericColumn<R> }
  | { max: NumericColumn<R> }
  | { count: AnyColumn<R>; as?: CountAs };

/** The `aggregate` spec: result-column name -> aggregate operation. */
export type AggregateInput<R> = Record<string, AggregateOp<R>>;

/** Map an aggregate op's `as` selector to its result-row TS type (default `number`). */
export type AggOutput<Op> = Op extends { as: "bigint" }
  ? bigint
  : Op extends { as: "string" }
    ? string
    : number;

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

/** The inferred result row: bucket + selected group-by columns + each aggregate (typed by `as`). */
export type TimeBucketRow<R, A extends TimeBucketArgs<R, unknown>> = Prettify<
  { bucket: Date } & { [K in Extract<GroupByOf<A>, keyof R>]: R[K] } & {
    // -readonly: `const A` marks the aggregate keys readonly; the result row shouldn't be.
    -readonly [K in keyof A["aggregate"]]: AggOutput<A["aggregate"][K]>;
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

// Valid `as` output per aggregate function — mirrors the per-function TS unions, and doubles
// as the set of valid function names. The runtime checks against this so a TypeScript bypass
// (an `any` cast or dynamically-built args) can't slip through a combination the types forbid
// — e.g. `avg` + `bigint` (which would silently round) or `count` + `string`.
const AGG_AS: Record<string, ReadonlySet<string>> = {
  sum: new Set(["number", "bigint", "string"]),
  avg: new Set(["number", "string"]),
  min: new Set(["number"]),
  max: new Set(["number"]),
  count: new Set(["number", "bigint"]),
};

/**
 * SQL cast that controls the JS type Prisma returns for an aggregate — the cast IS the type
 * selector (verified against Prisma 7 + @prisma/adapter-pg):
 *   `::bigint` -> JS `bigint` (exact integers)   `::text` -> JS `string` (exact decimal)
 * Default (`"number"` / unset): `count` -> `::int`, `sum`/`avg` -> `::double precision`
 * (JS `number`, loses precision past 2^53), `min`/`max` -> native (already a number for the
 * numeric column types those accept). Callers are validated against AGG_AS first.
 */
function castFor(fn: string, outputAs: string | undefined): string {
  if (outputAs === "bigint") return "::bigint";
  if (outputAs === "string") return "::text";
  if (fn === "count") return "::int";
  if (fn === "sum" || fn === "avg") return "::double precision";
  return ""; // min/max keep the column type
}

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
  schema?: string,
  relationsByModel: ReadonlyMap<string, readonly RelationConfig[]> = new Map(),
  model?: string,
): { sql: string; params: unknown[] } {
  assertSafeIdent(table, "model table");
  assertSafeIdent(timeColumn, "time column");
  if (schema !== undefined) assertSafeIdent(schema, "model schema");
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
    // Split the optional `as` selector from the single function entry ({ sum: "x", as: "bigint" }).
    const { as: outputAs, ...fnPart } = op;
    const entry = Object.entries(fnPart)[0];
    if (!entry) throw new Error(`timeBucket: aggregate "${resultName}" must specify a function.`);
    const [fn, column] = entry;
    const allowedAs = AGG_AS[fn];
    if (!allowedAs) {
      throw new Error(`timeBucket: unsupported aggregate function "${fn}" for "${resultName}".`);
    }
    if (outputAs !== undefined && !allowedAs.has(outputAs)) {
      throw new Error(
        `timeBucket: as: ${JSON.stringify(outputAs)} is not valid for "${fn}" on "${resultName}" (allowed: ${[...allowedAs].join(", ")}).`,
      );
    }
    const src = quoteIdent(col(column));
    const alias = quoteIdent(resultName);
    // The cast picks the JS return type: default `number`, or exact `bigint`/`string` via `as`.
    select.push(`${fn}(${src})${castFor(fn, outputAs)} AS ${alias}`);
  }

  // Relation-filter lookup (some/none/every/is/isNot -> EXISTS). Precompute every model's
  // field -> RuntimeRelation map once: the entry model drives the top level, and `relationsOf`
  // resolves relations reached THROUGH a relation (nested filters) by the related model's name.
  const relMaps = new Map<string, Map<string, RuntimeRelation>>();
  for (const [m, rels] of relationsByModel) {
    const fieldMap = new Map<string, RuntimeRelation>();
    for (const r of rels) {
      fieldMap.set(r.field, {
        table: qualifiedIdent(r.table, r.schema),
        list: r.list,
        on: r.on,
        ...(r.columns ? { columns: r.columns } : {}),
        ...(r.fk ? { fk: r.fk } : {}),
        ...(r.targetModel ? { targetModel: r.targetModel } : {}),
      });
    }
    relMaps.set(m, fieldMap);
  }
  const relationsOf = (m: string): ((f: string) => RuntimeRelation | undefined) | undefined => {
    const fieldMap = relMaps.get(m);
    return fieldMap ? (f: string) => fieldMap.get(f) : undefined;
  };
  const entryRelations = model !== undefined ? relMaps.get(model) : undefined;

  let where = `${time} >= $2 AND ${time} < $3`;
  const whereSql = whereToSql(args.where, {
    col: (name) => quoteIdent(col(name)),
    push: (value) => {
      params.push(value);
      return `$${params.length}`;
    },
    ...(entryRelations
      ? {
          rel: {
            outerTable: qualifiedIdent(table, schema),
            get: (f: string) => entryRelations.get(f),
            depth: 0,
            relationsOf,
          },
        }
      : {}),
  });
  if (whereSql) where += ` AND (${whereSql})`;

  const groupBy = [`"bucket"`, ...groupCols.map((g) => quoteIdent(g))].join(", ");
  const sql = `SELECT ${select.join(", ")} FROM ${qualifiedIdent(table, schema)} WHERE ${where} GROUP BY ${groupBy} ORDER BY "bucket"`;
  return { sql, params };
}
