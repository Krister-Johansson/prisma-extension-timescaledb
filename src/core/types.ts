// Shared core types: the config-in / SQL-out shapes the builders speak (SPEC §5, M1).
import type { Interval } from "./interval.js";

/** Every builder returns paired up/down SQL so migrations are reversible. */
export interface MigrationSql {
  up: string;
  down: string;
}

/** Optional data-retention policy attached to a hypertable (drops chunks older than `dropAfter`). */
export interface RetentionConfig {
  /** Drop chunks whose data is older than this interval (TimescaleDB `drop_after`). */
  dropAfter: Interval;
}

/** One ordering term for the columnstore `orderby` setting (segment-internal ordering). */
export interface CompressionOrderBy {
  /** Column to order by, as it exists in the DB (the @map name, or field name). */
  column: string;
  /** Sort direction; omitted lets TimescaleDB default (ascending). */
  direction?: "asc" | "desc";
  /** NULLS placement; omitted lets PostgreSQL default for the direction. */
  nulls?: "first" | "last";
}

/**
 * Optional columnstore-compression policy attached to a hypertable (TimescaleDB hypercore).
 * Enables the columnstore and schedules conversion of chunks older than `after`. Requires
 * TimescaleDB >= 2.18 (the `add_columnstore_policy` API).
 */
export interface CompressionConfig {
  /** Convert chunks whose data is older than this interval to the columnstore (`add_columnstore_policy(after => ...)`). */
  after: Interval;
  /** Columns to segment the columnstore by (`timescaledb.segmentby`), as DB names. Omitted = TimescaleDB default. */
  segmentBy?: readonly string[];
  /** Segment-internal ordering (`timescaledb.orderby`), DB column names. Omitted = TimescaleDB default. */
  orderBy?: readonly CompressionOrderBy[];
}

/**
 * A relation from a hypertable to another model, used to support relation filters
 * (`some`/`none`/`every`/`is`/`isNot`) in `timeBucket` where via EXISTS subqueries. All names
 * are DB names (post-@@map / @@schema).
 */
export interface RelationConfig {
  /** Prisma relation field name on the hypertable (the `where` key), e.g. "device". */
  field: string;
  /** Related model's DB table name. */
  table: string;
  /** Related model's `@@schema` (multiSchema); omitted for the default schema. */
  schema?: string;
  /** `true` for a to-many relation (`some`/`none`/`every`); `false` for to-one (`is`/`isNot`). */
  list: boolean;
  /** Join condition pairs — `related.<related> = hypertable.<outer>` (DB column names). */
  on: readonly { related: string; outer: string }[];
  /** Related Prisma field name -> DB column, for resolving the inner filter (@map). */
  columns?: Record<string, string>;
  /** For an optional to-one relation: the hypertable's FK column(s) (DB names), for `is`/`isNot: null`. */
  fk?: readonly string[];
}

/** Hypertable conversion config (SPEC §1.1 / §2.2). All names are DB names (post-@@map). */
export interface HypertableConfig {
  /**
   * Prisma model name, used by runtime helpers to resolve `prisma.<model>.timeBucket(...)`
   * back to this config. Omitted when it equals `table` (no @@map); callers fall back to `table`.
   */
  model?: string;
  /** Table/relation name as it exists in the DB, unquoted (the @@map name, or model name). */
  table: string;
  /** Database schema (the @@schema name) when using multiSchema; omitted for the default schema. */
  schema?: string;
  /** Time partitioning column, as it exists in the DB (the @map name, or field name). */
  column: string;
  /** Chunk size; defaults to "7 days" when omitted. */
  chunkInterval?: Interval;
  /**
   * Map of Prisma field name -> DB column name, for runtime helpers that take Prisma field
   * names (timeBucket where/groupBy/aggregate) and must emit DB column names. Omitted when
   * there are no @map renames (callers fall back to identity).
   */
  columns?: Record<string, string>;
  /** Optional data-retention policy (`@timescale.retention`); omitted means no policy. */
  retention?: RetentionConfig;
  /** Optional columnstore-compression policy (`@timescale.compression`); omitted means no policy. */
  compression?: CompressionConfig;
  /** Relations to other models, for relation filters in `timeBucket` where (EXISTS subqueries). */
  relations?: readonly RelationConfig[];
}

/** A single aggregate column in a continuous aggregate (SPEC §1.2). DB names. */
export interface AggregateSpec {
  /** Result column name in the cagg view, as Prisma reads it (the view field's DB name). */
  name: string;
  /** Aggregate function (v0.1 supported set). */
  fn: "avg" | "sum" | "min" | "max" | "count";
  /** Source column the function is applied to, as it exists in the DB. */
  column: string;
}

/** A group-by passthrough: select the source DB column, alias it to the view's DB column. */
export interface CaggGroupBy {
  /** Source table column (DB name) to group by. */
  source: string;
  /** Output column in the view (the view field's DB name). */
  output: string;
}

/** Continuous-aggregate refresh policy offsets (SPEC §1.2). */
export interface RefreshPolicy {
  startOffset: Interval;
  endOffset: Interval;
  scheduleInterval: Interval;
}

/** Continuous aggregate config (SPEC §1.2 / §2.3). */
export interface CaggConfig {
  /**
   * Prisma view model name, used by `$timescale.refreshContinuousAggregate(...)` to resolve
   * the caller's name to the DB view. Omitted when it equals `name` (no @@map).
   */
  model?: string;
  /** View name as it exists in the DB (the @@map name, or model name). */
  name: string;
  /** The view's database schema (@@schema), when using multiSchema. */
  schema?: string;
  /** Source hypertable table name (DB name). */
  source: string;
  /** The source hypertable's database schema (@@schema); may differ from the view's. */
  sourceSchema?: string;
  /** time_bucket interval. */
  bucket: Interval;
  /** Source time column the bucket is computed from. */
  timeColumn: string;
  /** Output column (view field DB name) for the time_bucket expression (`@timescale.bucket`). */
  bucketColumn: string;
  /** Optional group-by passthroughs (besides the bucket). `readonly` so a generated `as const`
   * registry is assignable (the generator builds mutable arrays, which assign fine). */
  groupBy?: readonly CaggGroupBy[];
  /** One or more aggregate columns. `readonly` for the same `as const` registry reason. */
  aggregates: readonly AggregateSpec[];
  /** Optional refresh policy; omitted means manual refresh only. */
  refresh?: RefreshPolicy;
}
