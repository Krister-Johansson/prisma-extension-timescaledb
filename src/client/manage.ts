// The $timescale management namespace (SPEC §4.3).
import { assertSafeIdent, qualifiedIdent, quoteLiteral, relationLiteral } from "../core/sql.js";
import { assertInterval, type Interval } from "../core/interval.js";
import { columnstoreReloptions, parseOrderByTerm } from "../core/compression.js";
import type { CompressionOrderBy, RefreshPolicy } from "../core/types.js";

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
  /** Read-returning raw query, for the introspection helpers (sizes, row count, dropped chunks). */
  $queryRawUnsafe<T = unknown>(query: string, ...values: unknown[]): Promise<T>;
}

/** Options for an on-demand chunk drop. At least one bound is required; each is an `Interval`
 * relative to now (matching retention's `dropAfter`). Absolute-timestamp cutoffs aren't supported —
 * `drop_chunks`'s bound type must match the partition column's exact (tz vs no-tz) type, which the
 * registry doesn't carry; use an interval relative to now instead. */
export interface DropChunksOptions {
  /** Drop chunks whose time range is entirely older than this interval before now. */
  olderThan?: Interval;
  /** Drop chunks whose time range is entirely newer than this interval before now (combine with `olderThan` for a window). */
  newerThan?: Interval;
}

/** Optional bounds for `showChunks`; both omitted lists every chunk. Intervals are relative to now (like `dropChunks`). */
export interface ShowChunksOptions {
  /** Only chunks whose time range is entirely older than this interval before now. */
  olderThan?: Interval;
  /** Only chunks whose time range is entirely newer than this interval before now (combine with `olderThan` for a window). */
  newerThan?: Interval;
}

/** Per-component byte sizes of a hypertable (from `hypertable_detailed_size`). */
export interface HypertableSize {
  tableBytes: bigint;
  indexBytes: bigint;
  toastBytes: bigint;
  totalBytes: bigint;
}

/** Columnstore-compression effectiveness for a hypertable (from `hypertable_columnstore_stats`). */
export interface CompressionStats {
  totalChunks: bigint;
  compressedChunks: bigint;
  /** Total bytes before compression across compressed chunks; `null` when nothing is compressed. */
  beforeTotalBytes: bigint | null;
  /** Total bytes after compression across compressed chunks; `null` when nothing is compressed. */
  afterTotalBytes: bigint | null;
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

/** A background job / policy row from `timescaledb_information.jobs`. */
export interface TimescaleJob {
  /** Numeric job id — the handle passed to alterJob / deleteJob / runJob. */
  jobId: number;
  /** Procedure name, e.g. `policy_retention`, `policy_compression`, `policy_refresh_continuous_aggregate`, or a custom action. */
  procName: string;
  /** Hypertable or continuous-aggregate (view) name the job targets; null for jobs not tied to a relation. */
  hypertableName: string | null;
  /** Run cadence (`schedule_interval`) as text, e.g. "1 day"; null for event-only jobs. */
  scheduleInterval: string | null;
  /** Whether the scheduler runs it (false = paused). */
  scheduled: boolean;
  /** The job's JSONB config (policy parameters), already parsed. */
  config: unknown;
  /** Next scheduled start; null if unscheduled. */
  nextStart: Date | null;
}

/** Per-job run statistics from `timescaledb_information.job_stats`. */
export interface JobStats {
  jobId: number;
  hypertableName: string | null;
  lastRunStartedAt: Date | null;
  lastSuccessfulFinish: Date | null;
  /** `Success` | `Failed` | … ; null before the first tracked run. */
  lastRunStatus: string | null;
  /** `Scheduled` | `Running` | `Paused` | … */
  jobStatus: string | null;
  /** Duration of the last run, as text; null before the first run. */
  lastRunDuration: string | null;
  nextStart: Date | null;
  totalRuns: bigint;
  totalSuccesses: bigint;
  totalFailures: bigint;
}

/** A recorded job failure from `timescaledb_information.job_errors`. */
export interface JobError {
  jobId: number;
  procName: string | null;
  startTime: Date | null;
  finishTime: Date | null;
  /** Postgres SQLSTATE of the failure. */
  sqlerrcode: string | null;
  /** Error message text (`err_message`). */
  message: string | null;
}

/** Options for `alterJob` — only the provided fields change; at least one is required. */
export interface AlterJobOptions {
  /** New run cadence (`schedule_interval`). */
  scheduleInterval?: Interval;
  /** Max time a single run may take (`max_runtime`). */
  maxRuntime?: Interval;
  /** Retry attempts on failure (`max_retries`). */
  maxRetries?: number;
  /** Wait between retries (`retry_period`). */
  retryPeriod?: Interval;
  /** Pause (`false`) or resume (`true`) the job. */
  scheduled?: boolean;
  /** Force the next start time (e.g. to run soon). To run immediately and synchronously, use `runJob`. */
  nextStart?: Date;
  /** Replace the job's JSONB config. */
  config?: unknown;
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
   * Add (or no-op re-add) a refresh policy to a continuous aggregate — `add_continuous_aggregate_policy`.
   * The complement of the `refresh: { ... }` annotation, and the way to set one on the manual-config path.
   * Idempotent (`if_not_exists`); NB TimescaleDB won't update an existing policy's offsets — remove it first.
   */
  addContinuousAggregatePolicy(name: CModels, options: RefreshPolicy): Promise<void>;

  /** Remove the refresh policy from a continuous aggregate (no-op if there is none). */
  removeContinuousAggregatePolicy(name: CModels): Promise<void>;

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

  /**
   * Drop chunks from a hypertable on demand (manual retention) — `drop_chunks`. At least one of
   * `olderThan` / `newerThan` is required; combine both for a window. Returns the dropped chunk names.
   */
  dropChunks(model: HModels, options: DropChunksOptions): Promise<string[]>;

  /** Total on-disk size of a hypertable in bytes (`hypertable_size`). */
  hypertableSize(model: HModels): Promise<bigint>;

  /** Per-component byte sizes of a hypertable: table / index / toast / total (`hypertable_detailed_size`). */
  hypertableDetailedSize(model: HModels): Promise<HypertableSize>;

  /** Approximate row count from planner statistics (`approximate_row_count`) — fast, may be 0 until ANALYZE. */
  approximateRowCount(model: HModels): Promise<bigint>;

  /** Columnstore-compression effectiveness: chunk counts and before/after sizes (`hypertable_columnstore_stats`). */
  compressionStats(model: HModels): Promise<CompressionStats>;

  /**
   * Enable chunk skipping on a secondary `column` of a hypertable — `enable_chunk_skipping`. The
   * planner can then exclude whole chunks that cannot match a filter on that column, but ONLY for
   * compressed chunks and ONLY when `timescaledb.enable_chunk_skipping` is on at query time (set it
   * on the connection or database — see the README; this call just registers the column). Accepts
   * the Prisma model name (resolved via @@map/@@schema) and a Prisma field name (mapped to its DB
   * column). Idempotent (`if_not_exists`). Do NOT pass the `segmentBy` column — skipping there
   * returns wrong (empty) results.
   */
  enableChunkSkipping(model: HModels, column: string): Promise<void>;

  /** Disable chunk skipping on a `column` of a hypertable — `disable_chunk_skipping`. Idempotent (no-op if not enabled). */
  disableChunkSkipping(model: HModels, column: string): Promise<void>;

  /**
   * Change the chunk (partition) interval of a hypertable's time dimension —
   * `set_partitioning_interval` (the non-deprecated successor to `set_chunk_time_interval`). Affects
   * only chunks created AFTER the call; existing chunks keep their interval. Accepts the Prisma model
   * name (resolved via @@map/@@schema). This is the way to resize a *live* hypertable: re-generating
   * the schema does not change it, since `create_hypertable` is a no-op once the table exists.
   */
  setChunkInterval(model: HModels, interval: Interval): Promise<void>;

  /**
   * List background jobs / policies — `timescaledb_information.jobs`. Pass a model name (hypertable
   * or continuous aggregate) to filter to that relation's jobs; omit for all. Surfaces the policies
   * this package creates (retention, compression, cagg refresh) plus any custom jobs, with their ids.
   */
  listJobs(model?: HModels | CModels): Promise<TimescaleJob[]>;

  /** Per-job run statistics — last/next run, status, and success/failure counts (`job_stats`). Optionally filtered by model. */
  jobStats(model?: HModels | CModels): Promise<JobStats[]>;

  /** Recent job failures — SQLSTATE + message (`job_errors`), newest first. Optionally filtered by model. */
  jobErrors(model?: HModels | CModels): Promise<JobError[]>;

  /**
   * Change a job's schedule or config — `alter_job`. Identify the job by its numeric id (from
   * `listJobs`). `{ scheduled: false }` pauses a policy, `{ scheduled: true }` resumes it,
   * `scheduleInterval` / `nextStart` reschedule, and `config` retunes it. No-op if the job no longer
   * exists (`if_exists`). At least one option must be provided.
   */
  alterJob(jobId: number, options: AlterJobOptions): Promise<void>;

  /** Delete a job by id — `delete_job`. (Policy jobs are better removed via their dedicated remove* method.) */
  deleteJob(jobId: number): Promise<void>;

  /** Run a job now, synchronously, regardless of its schedule — `run_job`. */
  runJob(jobId: number): Promise<void>;

  /**
   * List a hypertable's chunks — `show_chunks` — as relation names (e.g.
   * `_timescaledb_internal._hyper_1_2_chunk`), optionally bounded by the `olderThan` / `newerThan`
   * intervals (relative to now, like `dropChunks`). The returned names are the handles for
   * `compressChunk` / `decompressChunk`.
   */
  showChunks(model: HModels, options?: ShowChunksOptions): Promise<string[]>;

  /**
   * Convert a single chunk to the columnstore on demand — `compress_chunk`. Pass a chunk name from
   * `showChunks`. Requires the columnstore to be enabled on the hypertable (via `@timescale.compression`
   * or `addCompressionPolicy`). Idempotent: a no-op if the chunk is already compressed (`if_not_compressed`).
   */
  compressChunk(chunk: string): Promise<void>;

  /** Convert a single chunk back to the rowstore on demand — `decompress_chunk`. Idempotent if already uncompressed (`if_compressed`). */
  decompressChunk(chunk: string): Promise<void>;
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

  /** Resolve a Prisma view model name to its continuous-aggregate DB ref (identity when unregistered). */
  const resolveCagg = (name: string): CaggRef => {
    const ref = viewByModel.get(name) ?? { name };
    assertSafeIdent(ref.name, "continuous aggregate name");
    if (ref.schema !== undefined) assertSafeIdent(ref.schema, "continuous aggregate schema");
    return ref;
  };

  /**
   * Build the single-statement `DO` block for enable/disable chunk skipping. The GUC
   * `timescaledb.enable_chunk_skipping` must be on for the function to be callable, so `SET LOCAL`
   * + the `PERFORM` live in ONE block run by ONE `$executeRawUnsafe` — i.e. one pooled connection —
   * so the GUC reliably applies to the call. The column is a Prisma field name mapped to its DB
   * column (@map); `if_not_exists => TRUE` makes both directions idempotent.
   */
  const chunkSkippingSql = (
    model: string,
    column: string,
    fn: "enable_chunk_skipping" | "disable_chunk_skipping",
  ): string => {
    const ref = resolveHypertable(model);
    const dbColumn = (ref.columns ?? {})[column] ?? column;
    assertSafeIdent(dbColumn, "chunk-skipping column");
    const rel = relationLiteral(ref.table, ref.schema);
    return `DO $$ BEGIN SET LOCAL timescaledb.enable_chunk_skipping = on; PERFORM ${fn}(${rel}, ${quoteLiteral(dbColumn)}, if_not_exists => TRUE); END $$`;
  };

  /** Validate a job id and render it as a SQL integer literal (it is a number, so inlining is injection-safe). */
  const jobIdLiteral = (jobId: number): string => {
    if (!Number.isInteger(jobId) || jobId < 0) {
      throw new Error(`Invalid job id ${JSON.stringify(jobId)}: expected a non-negative integer.`);
    }
    return String(jobId);
  };

  /**
   * Validate a chunk name (an optionally schema-qualified relation, as returned by `showChunks`) and
   * render it as a quoted string literal for the `regclass` argument of compress/decompress — no
   * `::regclass` cast (constraint 2); the implicit text->regclass resolution handles the rest. The
   * per-part identifier check makes embedding the value injection-safe.
   */
  const chunkLiteral = (chunk: string): string => {
    const SAFE_QUALIFIED = /^[A-Za-z_][A-Za-z0-9_]*(\.[A-Za-z_][A-Za-z0-9_]*)?$/;
    if (!SAFE_QUALIFIED.test(chunk)) {
      throw new Error(
        `Invalid chunk name ${JSON.stringify(chunk)}: expected an (optionally schema-qualified) relation name from showChunks.`,
      );
    }
    return quoteLiteral(chunk);
  };

  /** Resolve a model name to the DB relation name the jobs views key on: a hypertable's table, or a cagg's view name. */
  const resolveRelationName = (model: string): { name: string; schema?: string } => {
    const ht = hypertableByModel.get(model);
    if (ht) return { name: ht.table, ...(ht.schema !== undefined ? { schema: ht.schema } : {}) };
    const cagg = viewByModel.get(model);
    if (cagg) return { name: cagg.name, ...(cagg.schema !== undefined ? { schema: cagg.schema } : {}) };
    return { name: model };
  };

  /** Build a `hypertable_name`/`hypertable_schema` filter (bound params) for the jobs views; empty when no model. */
  const jobFilter = (model: string | undefined, prefix = ""): { where: string; params: unknown[] } => {
    if (model === undefined) return { where: "", params: [] };
    const rel = resolveRelationName(model);
    const params: unknown[] = [rel.name];
    let where = `WHERE ${prefix}hypertable_name = $1`;
    if (rel.schema !== undefined) {
      params.push(rel.schema);
      where += ` AND ${prefix}hypertable_schema = $2`;
    }
    return { where, params };
  };

  return {
    async refreshContinuousAggregate(name, range) {
      const ref = resolveCagg(name);
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

    async addContinuousAggregatePolicy(name, opts) {
      const ref = resolveCagg(name);
      assertInterval(opts.startOffset);
      assertInterval(opts.endOffset);
      assertInterval(opts.scheduleInterval);
      const rel = relationLiteral(ref.name, ref.schema);
      // Offsets are strict-grammar Intervals quoted as literals; if_not_exists keeps a re-add a no-op.
      await client.$executeRawUnsafe(
        `SELECT add_continuous_aggregate_policy(${rel}, start_offset => INTERVAL ${quoteLiteral(opts.startOffset)}, end_offset => INTERVAL ${quoteLiteral(opts.endOffset)}, schedule_interval => INTERVAL ${quoteLiteral(opts.scheduleInterval)}, if_not_exists => TRUE)`,
      );
    },

    async removeContinuousAggregatePolicy(name) {
      const ref = resolveCagg(name);
      // remove_continuous_aggregate_policy's idempotent flag is (confusingly) named if_not_exists.
      await client.$executeRawUnsafe(
        `SELECT remove_continuous_aggregate_policy(${relationLiteral(ref.name, ref.schema)}, if_not_exists => TRUE)`,
      );
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

    async dropChunks(model, opts) {
      const ref = resolveHypertable(model);
      const rel = relationLiteral(ref.table, ref.schema);
      // Each bound is a validated Interval interpolated as `INTERVAL '...'` — a typed literal, so
      // `older_than`'s polymorphic "any" parameter resolves (a bind param would be type-ambiguous).
      const bound = (key: string, value: Interval | undefined): string | undefined => {
        if (value === undefined) return undefined;
        assertInterval(value);
        return `${key} => INTERVAL ${quoteLiteral(value)}`;
      };
      const args = [bound("older_than", opts.olderThan), bound("newer_than", opts.newerThan)].filter(
        (a): a is string => a !== undefined,
      );
      if (args.length === 0) {
        throw new Error("dropChunks: specify olderThan and/or newerThan.");
      }
      const rows = await client.$queryRawUnsafe<{ chunk: string }[]>(
        `SELECT drop_chunks(${rel}, ${args.join(", ")}) AS chunk`,
      );
      return rows.map((r) => r.chunk);
    },

    async hypertableSize(model) {
      const ref = resolveHypertable(model);
      const rows = await client.$queryRawUnsafe<{ bytes: bigint }[]>(
        `SELECT hypertable_size(${relationLiteral(ref.table, ref.schema)}) AS bytes`,
      );
      return rows[0]?.bytes ?? 0n;
    },

    async hypertableDetailedSize(model) {
      const ref = resolveHypertable(model);
      const rows = await client.$queryRawUnsafe<
        { table_bytes: bigint; index_bytes: bigint; toast_bytes: bigint; total_bytes: bigint }[]
      >(
        `SELECT table_bytes, index_bytes, toast_bytes, total_bytes FROM hypertable_detailed_size(${relationLiteral(ref.table, ref.schema)})`,
      );
      const r = rows[0];
      return {
        tableBytes: r?.table_bytes ?? 0n,
        indexBytes: r?.index_bytes ?? 0n,
        toastBytes: r?.toast_bytes ?? 0n,
        totalBytes: r?.total_bytes ?? 0n,
      };
    },

    async approximateRowCount(model) {
      const ref = resolveHypertable(model);
      const rows = await client.$queryRawUnsafe<{ count: bigint }[]>(
        `SELECT approximate_row_count(${relationLiteral(ref.table, ref.schema)}) AS count`,
      );
      return rows[0]?.count ?? 0n;
    },

    async compressionStats(model) {
      const ref = resolveHypertable(model);
      const rows = await client.$queryRawUnsafe<
        {
          total_chunks: bigint;
          number_compressed_chunks: bigint;
          before_compression_total_bytes: bigint | null;
          after_compression_total_bytes: bigint | null;
        }[]
      >(
        `SELECT total_chunks, number_compressed_chunks, before_compression_total_bytes, after_compression_total_bytes FROM hypertable_columnstore_stats(${relationLiteral(ref.table, ref.schema)})`,
      );
      const r = rows[0];
      return {
        totalChunks: r?.total_chunks ?? 0n,
        compressedChunks: r?.number_compressed_chunks ?? 0n,
        beforeTotalBytes: r?.before_compression_total_bytes ?? null,
        afterTotalBytes: r?.after_compression_total_bytes ?? null,
      };
    },

    async enableChunkSkipping(model, column) {
      await client.$executeRawUnsafe(chunkSkippingSql(model, column, "enable_chunk_skipping"));
    },

    async disableChunkSkipping(model, column) {
      await client.$executeRawUnsafe(chunkSkippingSql(model, column, "disable_chunk_skipping"));
    },

    async setChunkInterval(model, interval) {
      const ref = resolveHypertable(model);
      assertInterval(interval);
      const rel = relationLiteral(ref.table, ref.schema);
      // The polymorphic `anyelement` interval resolves from the typed `INTERVAL '...'` literal (a
      // bind param would be type-ambiguous); no dimension_name => the time dimension. No cast on the
      // relation (constraint 2).
      await client.$executeRawUnsafe(`SELECT set_partitioning_interval(${rel}, INTERVAL ${quoteLiteral(interval)})`);
    },

    async listJobs(model) {
      const { where, params } = jobFilter(model);
      const rows = await client.$queryRawUnsafe<
        {
          job_id: number;
          proc_name: string;
          hypertable_name: string | null;
          schedule_interval: string | null;
          scheduled: boolean;
          config: unknown;
          next_start: Date | null;
        }[]
      >(
        [
          "SELECT job_id, proc_name, hypertable_name, schedule_interval::text AS schedule_interval, scheduled, config, next_start",
          "FROM timescaledb_information.jobs",
          where,
          "ORDER BY job_id",
        ]
          .filter(Boolean)
          .join(" "),
        ...params,
      );
      return rows.map((r) => ({
        jobId: Number(r.job_id),
        procName: r.proc_name,
        hypertableName: r.hypertable_name,
        scheduleInterval: r.schedule_interval,
        scheduled: r.scheduled,
        config: r.config,
        nextStart: r.next_start,
      }));
    },

    async jobStats(model) {
      const { where, params } = jobFilter(model);
      const rows = await client.$queryRawUnsafe<
        {
          job_id: number;
          hypertable_name: string | null;
          last_run_started_at: Date | null;
          last_successful_finish: Date | null;
          last_run_status: string | null;
          job_status: string | null;
          last_run_duration: string | null;
          next_start: Date | null;
          total_runs: bigint | null;
          total_successes: bigint | null;
          total_failures: bigint | null;
        }[]
      >(
        [
          "SELECT job_id, hypertable_name, last_run_started_at, last_successful_finish, last_run_status,",
          "job_status, last_run_duration::text AS last_run_duration, next_start,",
          "COALESCE(total_runs, 0)::bigint AS total_runs,",
          "COALESCE(total_successes, 0)::bigint AS total_successes,",
          "COALESCE(total_failures, 0)::bigint AS total_failures",
          "FROM timescaledb_information.job_stats",
          where,
          "ORDER BY job_id",
        ]
          .filter(Boolean)
          .join(" "),
        ...params,
      );
      return rows.map((r) => ({
        jobId: Number(r.job_id),
        hypertableName: r.hypertable_name,
        lastRunStartedAt: r.last_run_started_at,
        lastSuccessfulFinish: r.last_successful_finish,
        lastRunStatus: r.last_run_status,
        jobStatus: r.job_status,
        lastRunDuration: r.last_run_duration,
        nextStart: r.next_start,
        totalRuns: r.total_runs ?? 0n,
        totalSuccesses: r.total_successes ?? 0n,
        totalFailures: r.total_failures ?? 0n,
      }));
    },

    async jobErrors(model) {
      // job_errors has no hypertable_name column, so a model filter joins to the jobs view by job_id.
      const rel = model === undefined ? undefined : resolveRelationName(model);
      const params: unknown[] = [];
      let from = "timescaledb_information.job_errors e";
      let where = "";
      if (rel) {
        from += " JOIN timescaledb_information.jobs j ON j.job_id = e.job_id";
        params.push(rel.name);
        where = "WHERE j.hypertable_name = $1";
        if (rel.schema !== undefined) {
          params.push(rel.schema);
          where += " AND j.hypertable_schema = $2";
        }
      }
      const rows = await client.$queryRawUnsafe<
        {
          job_id: number;
          proc_name: string | null;
          start_time: Date | null;
          finish_time: Date | null;
          sqlerrcode: string | null;
          err_message: string | null;
        }[]
      >(
        [
          "SELECT e.job_id, e.proc_name, e.start_time, e.finish_time, e.sqlerrcode, e.err_message",
          `FROM ${from}`,
          where,
          "ORDER BY e.start_time DESC NULLS LAST",
        ]
          .filter(Boolean)
          .join(" "),
        ...params,
      );
      return rows.map((r) => ({
        jobId: Number(r.job_id),
        procName: r.proc_name,
        startTime: r.start_time,
        finishTime: r.finish_time,
        sqlerrcode: r.sqlerrcode,
        message: r.err_message,
      }));
    },

    async alterJob(jobId, options) {
      const id = jobIdLiteral(jobId);
      const args: string[] = [];
      const params: unknown[] = [];
      const interval = (key: string, value: Interval | undefined): void => {
        if (value === undefined) return;
        assertInterval(value);
        args.push(`${key} => INTERVAL ${quoteLiteral(value)}`);
      };
      interval("schedule_interval", options.scheduleInterval);
      interval("max_runtime", options.maxRuntime);
      interval("retry_period", options.retryPeriod);
      if (options.maxRetries !== undefined) {
        if (!Number.isInteger(options.maxRetries) || options.maxRetries < 0) {
          throw new Error(
            `alterJob: maxRetries must be a non-negative integer (got ${JSON.stringify(options.maxRetries)}).`,
          );
        }
        args.push(`max_retries => ${options.maxRetries}`);
      }
      if (options.scheduled !== undefined) args.push(`scheduled => ${options.scheduled ? "TRUE" : "FALSE"}`);
      if (options.nextStart !== undefined) {
        params.push(options.nextStart);
        args.push(`next_start => $${params.length}`);
      }
      if (options.config !== undefined) {
        params.push(JSON.stringify(options.config));
        args.push(`config => $${params.length}::jsonb`);
      }
      if (args.length === 0) {
        throw new Error("alterJob: specify at least one option to change.");
      }
      // if_exists => TRUE makes altering an already-removed job a no-op instead of an error.
      await client.$executeRawUnsafe(`SELECT alter_job(${id}, ${args.join(", ")}, if_exists => TRUE)`, ...params);
    },

    async deleteJob(jobId) {
      await client.$executeRawUnsafe(`SELECT delete_job(${jobIdLiteral(jobId)})`);
    },

    async runJob(jobId) {
      // run_job is a PROCEDURE — CALL it; it runs the job synchronously on this connection.
      await client.$executeRawUnsafe(`CALL run_job(${jobIdLiteral(jobId)})`);
    },

    async showChunks(model, options = {}) {
      const ref = resolveHypertable(model);
      const rel = relationLiteral(ref.table, ref.schema);
      // Bounds are validated Intervals interpolated as typed `INTERVAL '...'` literals (the args are
      // polymorphic "any" — a bind param would be type-ambiguous, same as dropChunks). Both optional.
      const bound = (key: string, value: Interval | undefined): string | undefined => {
        if (value === undefined) return undefined;
        assertInterval(value);
        return `${key} => INTERVAL ${quoteLiteral(value)}`;
      };
      const args = [rel, bound("older_than", options.olderThan), bound("newer_than", options.newerThan)].filter(
        (a): a is string => a !== undefined,
      );
      const rows = await client.$queryRawUnsafe<{ chunk: string }[]>(
        `SELECT c::text AS chunk FROM show_chunks(${args.join(", ")}) c ORDER BY c`,
      );
      return rows.map((r) => r.chunk);
    },

    async compressChunk(chunk) {
      await client.$executeRawUnsafe(`SELECT compress_chunk(${chunkLiteral(chunk)}, if_not_compressed => TRUE)`);
    },

    async decompressChunk(chunk) {
      await client.$executeRawUnsafe(`SELECT decompress_chunk(${chunkLiteral(chunk)}, if_compressed => TRUE)`);
    },
  };
}
