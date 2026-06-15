// Shared core types: the config-in / SQL-out shapes the builders speak (SPEC §5, M1).
import type { Interval } from "./interval.js";

/** Every builder returns paired up/down SQL so migrations are reversible. */
export interface MigrationSql {
  up: string;
  down: string;
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
  /** Source hypertable model name. */
  source: string;
  /** time_bucket interval. */
  bucket: Interval;
  /** Source time column the bucket is computed from. */
  timeColumn: string;
  /** Output column (view field DB name) for the time_bucket expression (`@timescale.bucket`). */
  bucketColumn: string;
  /** Optional group-by passthroughs (besides the bucket). */
  groupBy?: CaggGroupBy[];
  /** One or more aggregate columns. */
  aggregates: AggregateSpec[];
  /** Optional refresh policy; omitted means manual refresh only. */
  refresh?: RefreshPolicy;
}
