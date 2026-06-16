// Public "./core" entry: pure config-in / SQL-out builders, usable directly in
// hand-written migrations (SPEC §5). Dependency-light, no Prisma imports.
export type {
  MigrationSql,
  HypertableConfig,
  RetentionConfig,
  CompressionConfig,
  CompressionOrderBy,
  RelationConfig,
  CaggConfig,
  AggregateSpec,
  RefreshPolicy,
} from "./types.js";
export type { Interval } from "./interval.js";
export { assertInterval, isInterval } from "./interval.js";
export { createExtensionSql } from "./extension.js";
export { createHypertableSql } from "./hypertable.js";
export { createContinuousAggregateSql } from "./continuousAggregate.js";
export { createRetentionPolicySql, type RetentionPolicyConfig } from "./retention.js";
export { createCompressionPolicySql, type CompressionPolicyConfig } from "./compression.js";
export { createChunkSkippingSql, type ChunkSkippingConfig } from "./chunkSkipping.js";
export { quoteIdent, quoteLiteral, qualifiedIdent, relationLiteral, assertSafeIdent } from "./sql.js";
