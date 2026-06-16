// The $timescale management namespace (SPEC §4.3).
import { assertSafeIdent, qualifiedIdent, quoteLiteral, relationLiteral } from "../core/sql.js";
import { assertInterval, type Interval } from "../core/interval.js";
import { columnstoreReloptions, parseOrderByTerm } from "../core/compression.js";
import type { CompressionOrderBy } from "../core/types.js";

/** Resolved DB identity of a continuous aggregate (name + optional @@schema). */
export interface CaggRef {
  name: string;
  schema?: string;
}

/** Resolved DB identity of a hypertable (relation + optional @@schema + @map column map). */
export interface HypertableRef {
  table: string;
  schema?: string;
  /** Prisma field name -> DB column, to map `segmentBy`/`orderBy` in addCompressionPolicy (@map). */
  columns?: Record<string, string>;
}

/** Options for a data-retention policy. */
export interface RetentionOptions {
  /** Drop chunks whose data is older than this interval (TimescaleDB `drop_after`). */
  dropAfter: Interval;
}

/** One ordering term for `addCompressionPolicy`'s `orderBy` (a Prisma field name + direction). */
export interface CompressionOrderByInput {
  /** Prisma field name to order by (mapped to its @map DB column). */
  column: string;
  direction?: "asc" | "desc";
  nulls?: "first" | "last";
}

/** Options for a columnstore-compression policy. */
export interface CompressionOptions {
  /** Convert chunks whose data is older than this interval to the columnstore. */
  after: Interval;
  /** Column(s) to segment by — Prisma field name(s), mapped to DB columns. A comma-separated string or an array. */
  segmentBy?: string | readonly string[];
  /** Segment-internal ordering — `"time DESC"`, a comma list, an array of terms, or structured objects. */
  orderBy?: string | readonly (string | CompressionOrderByInput)[];
}

/** Minimal raw-capable client surface we rely on (PrismaClient provides these). */
export interface RawClient {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/** Range for a continuous-aggregate refresh; null bounds mean "open" (full refresh). */
export interface RefreshRange {
  start?: Date | null;
  end?: Date | null;
}

/** Registry refs + tuning for the `$timescale` namespace. */
export interface ManageOptions {
  /** Prisma model name -> hypertable DB relation, for the retention helpers (@@map/@@schema). */
  hypertableByModel?: ReadonlyMap<string, HypertableRef>;
  /**
   * Max attempts for a refresh that collides with the cagg's background refresh policy
   * (SQLSTATE 55P03). Default 8.
   */
  maxRefreshAttempts?: number;
  /** Delay between retries (ms -> Promise). Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

/**
 * The `$timescale` management namespace. The type parameters are the registered model-name
 * unions taken from the config/registry, so a name argument is checked at compile time — a
 * typo like `"SensorRead"` is a type error. They default to `string` for the manual config
 * path or when the names aren't string literals.
 *
 * @typeParam HModels - registered hypertable model names (retention helpers)
 * @typeParam CModels - registered continuous-aggregate model names (refresh)
 */
export interface TimescaleManage<HModels extends string = string, CModels extends string = string> {
  /**
   * Refresh a continuous aggregate over an optional time window (SPEC §4.3).
   * Accepts the Prisma view model name; it is resolved to the DB view name (@@map) and passed
   * as a quoted identifier so mixed-case caggs resolve correctly (an unquoted name case-folds
   * and fails — surfaced in the spike).
   *
   * If a scheduled refresh policy is running on the same cagg, the manual refresh briefly
   * retries (see SQLSTATE 55P03 below) instead of failing.
   */
  refreshContinuousAggregate(name: CModels, range?: RefreshRange): Promise<void>;

  /**
   * Add a data-retention policy to a hypertable — drops chunks whose data is older than
   * `dropAfter`. Accepts the Prisma model name (resolved to the DB relation via @@map/@@schema).
   * Idempotent: re-adding an identical policy is a no-op. NB: TimescaleDB will NOT update an
   * existing policy whose `dropAfter` differs — remove it first.
   */
  addRetentionPolicy(model: HModels, options: RetentionOptions): Promise<void>;

  /** Remove the data-retention policy from a hypertable (no-op if there is none). */
  removeRetentionPolicy(model: HModels): Promise<void>;

  /**
   * Add a columnstore-compression policy to a hypertable — enables the columnstore (with the given
   * `segmentBy`/`orderBy`) and schedules conversion of chunks older than `after` to the columnstore.
   * Accepts the Prisma model name (resolved via @@map/@@schema) and Prisma field names for
   * `segmentBy`/`orderBy` (mapped to DB columns). Idempotent. Requires TimescaleDB >= 2.18. NB:
   * TimescaleDB will NOT update an existing policy whose `after` differs, and changed
   * `segmentBy`/`orderBy` apply only to future compressions — remove the policy first to change them.
   */
  addCompressionPolicy(model: HModels, options: CompressionOptions): Promise<void>;

  /**
   * Remove the columnstore-compression policy from a hypertable (no-op if there is none). Leaves
   * the columnstore itself enabled — disabling it fails once any chunk has been compressed.
   */
  removeCompressionPolicy(model: HModels): Promise<void>;
}

// SQLSTATE 55P03 (lock_not_available): TimescaleDB raises this when a manual
// refresh_continuous_aggregate() overlaps the cagg's scheduled refresh-policy job
// ("could not refresh continuous aggregate ... due to a concurrent refresh"). It is
// transient — the policy job releases the lock when it finishes — so an explicit refresh
// briefly retries rather than surfacing a spurious failure to the caller.
const CONCURRENT_REFRESH_SQLSTATE = "55P03";

function isConcurrentRefreshError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { meta?: { code?: unknown }; message?: unknown };
  // Driver adapters expose the Postgres SQLSTATE on the error's `meta.code`.
  if (e.meta?.code === CONCURRENT_REFRESH_SQLSTATE) return true;
  // Fallback: the SQLSTATE is rendered into Prisma's raw-query error message
  // (`Raw query failed. Code: \`55P03\`. ...`) across client/adapter versions.
  return typeof e.message === "string" && e.message.includes(CONCURRENT_REFRESH_SQLSTATE);
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Normalize a `segmentBy` input (comma-separated string or array) to trimmed, non-empty field names. */
function normalizeSegmentBy(input: string | readonly string[] | undefined): string[] | undefined {
  if (input == null) return undefined;
  const fields = (typeof input === "string" ? input.split(",") : input).map((s) => s.trim()).filter(Boolean);
  return fields.length > 0 ? fields : undefined;
}

/** Normalize an `orderBy` input (comma string, or array of `"col DESC"` strings / structured terms) to terms. */
function normalizeOrderBy(
  input: string | readonly (string | CompressionOrderBy)[] | undefined,
): CompressionOrderBy[] | undefined {
  if (input == null) return undefined;
  const entries = typeof input === "string" ? input.split(",").map((s) => s.trim()).filter(Boolean) : input;
  const terms = entries.map((e) => (typeof e === "string" ? parseOrderByTerm(e) : e));
  return terms.length > 0 ? terms : undefined;
}

/** @param viewByModel Prisma view model name -> { DB view name, schema } (for @@map/@@schema). */
export function makeManage<HModels extends string = string, CModels extends string = string>(
  client: RawClient,
  viewByModel: ReadonlyMap<string, CaggRef> = new Map(),
  options: ManageOptions = {},
): TimescaleManage<HModels, CModels> {
  // Coerce to a finite integer >= 1. A NaN here would make the retry loop's `attempt <=
  // maxAttempts` guard false on the first iteration — a silent no-op that never runs the
  // refresh — and Infinity would retry unboundedly on repeated 55P03; both fall back to 8.
  const requestedAttempts = options.maxRefreshAttempts ?? 8;
  const maxAttempts = Number.isFinite(requestedAttempts) ? Math.max(1, Math.floor(requestedAttempts)) : 8;
  const sleep = options.sleep ?? defaultSleep;
  const hypertableByModel = options.hypertableByModel ?? new Map<string, HypertableRef>();

  /** Resolve a Prisma model name to its hypertable DB relation (identity when unregistered). */
  const resolveHypertable = (model: string): HypertableRef => {
    const ref = hypertableByModel.get(model) ?? { table: model };
    assertSafeIdent(ref.table, "hypertable table");
    if (ref.schema !== undefined) assertSafeIdent(ref.schema, "hypertable schema");
    return ref;
  };

  return {
    async refreshContinuousAggregate(name, range) {
      const ref = viewByModel.get(name) ?? { name };
      assertSafeIdent(ref.name, "continuous aggregate name");
      if (ref.schema !== undefined) assertSafeIdent(ref.schema, "continuous aggregate schema");
      // Open bounds (full refresh) must be a literal NULL, not a bound param: Postgres
      // can't infer the type of a NULL parameter for the function's "any" window args.
      const params: unknown[] = [];
      const bound = (value: Date | null | undefined): string => {
        if (value == null) return "NULL";
        params.push(value);
        return `$${params.length}`;
      };
      const target = qualifiedIdent(ref.name, ref.schema);
      const sql = `CALL refresh_continuous_aggregate('${target}', ${bound(range?.start)}, ${bound(range?.end)})`;
      // Retry only on a concurrent policy refresh (55P03), with bounded exponential backoff.
      // Any other error — or exhausting the attempt budget — propagates unchanged.
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          await client.$executeRawUnsafe(sql, ...params);
          return;
        } catch (err) {
          if (attempt >= maxAttempts || !isConcurrentRefreshError(err)) throw err;
          await sleep(Math.min(50 * 2 ** (attempt - 1), 1000));
        }
      }
    },

    async addRetentionPolicy(model, opts) {
      const ref = resolveHypertable(model);
      assertInterval(opts.dropAfter);
      const rel = relationLiteral(ref.table, ref.schema);
      // drop_after is a strict-grammar Interval (assertInterval) quoted as a literal — no cast
      // on the relation (constraint 2); if_not_exists keeps a re-add a no-op.
      const sql = `SELECT add_retention_policy(${rel}, drop_after => INTERVAL ${quoteLiteral(opts.dropAfter)}, if_not_exists => TRUE)`;
      await client.$executeRawUnsafe(sql);
    },

    async removeRetentionPolicy(model) {
      const ref = resolveHypertable(model);
      const rel = relationLiteral(ref.table, ref.schema);
      await client.$executeRawUnsafe(`SELECT remove_retention_policy(${rel}, if_exists => TRUE)`);
    },

    async addCompressionPolicy(model, opts) {
      const ref = resolveHypertable(model);
      assertInterval(opts.after);
      const columns = ref.columns ?? {};
      const mapCol = (field: string): string => columns[field] ?? field;
      const segmentBy = normalizeSegmentBy(opts.segmentBy)?.map(mapCol);
      const orderBy = normalizeOrderBy(opts.orderBy)?.map((o) => ({ ...o, column: mapCol(o.column) }));
      // columnstoreReloptions validates + quotes the (mapped) column identifiers.
      const reloptions = columnstoreReloptions(segmentBy, orderBy);
      const rel = relationLiteral(ref.table, ref.schema);
      const alterTarget = qualifiedIdent(ref.table, ref.schema);
      // Two statements: add_columnstore_policy errors unless the columnstore is enabled first.
      await client.$executeRawUnsafe(`ALTER TABLE ${alterTarget} SET (${reloptions.join(", ")})`);
      await client.$executeRawUnsafe(
        `CALL add_columnstore_policy(${rel}, after => INTERVAL ${quoteLiteral(opts.after)}, if_not_exists => TRUE)`,
      );
    },

    async removeCompressionPolicy(model) {
      const ref = resolveHypertable(model);
      const rel = relationLiteral(ref.table, ref.schema);
      await client.$executeRawUnsafe(`CALL remove_columnstore_policy(${rel}, if_exists => TRUE)`);
    },
  };
}
