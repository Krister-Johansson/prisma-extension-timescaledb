// Package root ("." export): the runtime surface users import.
//   import { timescaledb } from "prisma-extension-timescaledb";
//
// The generator (src/generator) is deliberately NOT re-exported here — it runs as a Prisma
// generator binary, and the runtime must not depend on it (CLAUDE.md resilience rule).
export { timescaledb } from "./client/index.js";
export type { TimescaleConfig } from "./client/index.js";

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
