// Shared core types: the config-in / SQL-out shapes the builders speak (SPEC §5, M1).
import type { Interval } from "./interval.js";

/** Every builder returns paired up/down SQL so migrations are reversible. */
export interface MigrationSql {
  up: string;
  down: string;
}

/** Hypertable conversion config (SPEC §1.1 / §2.2). */
export interface HypertableConfig {
  /** Table/relation name as it exists in the DB, unquoted (e.g. "SensorReading"). */
  table: string;
  /** Time partitioning column (e.g. "time"). */
  column: string;
  /** Chunk size; defaults to "7 days" when omitted. */
  chunkInterval?: Interval;
}

/** A single aggregate column in a continuous aggregate (SPEC §1.2). */
export interface AggregateSpec {
  /** Result column name in the cagg view. */
  name: string;
  /** Aggregate function (v0.1 supported set). */
  fn: "avg" | "sum" | "min" | "max" | "count";
  /** Source column the function is applied to. */
  column: string;
}

/** Continuous-aggregate refresh policy offsets (SPEC §1.2). */
export interface RefreshPolicy {
  startOffset: Interval;
  endOffset: Interval;
  scheduleInterval: Interval;
}

/** Continuous aggregate config (SPEC §1.2 / §2.3). */
export interface CaggConfig {
  /** View name (e.g. "SensorHourly"). */
  name: string;
  /** Source hypertable model name. */
  source: string;
  /** time_bucket interval. */
  bucket: Interval;
  /** Source time column the bucket is computed from. */
  timeColumn: string;
  /** Output column name for the time_bucket expression (the view's `@timescale.bucket` field). */
  bucketColumn: string;
  /** Optional group-by columns (besides the bucket). */
  groupBy?: string[];
  /** One or more aggregate columns. */
  aggregates: AggregateSpec[];
  /** Optional refresh policy; omitted means manual refresh only. */
  refresh?: RefreshPolicy;
}
