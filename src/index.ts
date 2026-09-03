// Package root ("." export): the runtime surface users import.
//   import { timescaledb } from "prisma-extension-timescaledb";
//
// The generator (src/generator) is deliberately NOT re-exported here — it runs as a Prisma
// generator binary, and the runtime must not depend on it (CLAUDE.md resilience rule).
export { timescaledb } from "./client/index.js";
export type { TimescaleConfig } from "./client/index.js";
// Management namespace types ($timescale), so callers can name the return shapes.
export type {
  TimescaleManage,
  RefreshRange,
  TimescaleJob,
  JobStats,
  JobError,
  AlterJobOptions,
} from "./client/index.js";
// timeBucket types, so callers can type wrappers around model.timeBucket(...) — the client
// barrel re-exported these but the package root (the only published entry) did not.
export type {
  TimeBucketArgs,
  TimeBucketRow,
  AggregateInput,
  AggregateOp,
  ScalarRow,
  WhereInput,
} from "./client/timeBucket.js";

// Re-export the core types + SQL builders for convenience (also available at "./core").
export type {
  MigrationSql,
  HypertableConfig,
  CaggConfig,
  AggregateSpec,
  RefreshPolicy,
  Interval,
} from "./core/index.js";
export {
  assertInterval,
  createExtensionSql,
  createHypertableSql,
  createContinuousAggregateSql,
} from "./core/index.js";
