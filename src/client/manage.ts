// The $timescale management namespace (SPEC §4.3).
import { assertSafeIdent, qualifiedIdent } from "../core/sql.js";

/** Resolved DB identity of a continuous aggregate (name + optional @@schema). */
export interface CaggRef {
  name: string;
  schema?: string;
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

/** Tuning for the concurrent-refresh retry. Defaults are sensible; mainly for tests. */
export interface ManageOptions {
  /**
   * Max attempts for a refresh that collides with the cagg's background refresh policy
   * (SQLSTATE 55P03). Default 8.
   */
  maxRefreshAttempts?: number;
  /** Delay between retries (ms -> Promise). Injectable for deterministic tests. */
  sleep?: (ms: number) => Promise<void>;
}

export interface TimescaleManage {
  /**
   * Refresh a continuous aggregate over an optional time window (SPEC §4.3).
   * Accepts the Prisma view model name; it is resolved to the DB view name (@@map) and passed
   * as a quoted identifier so mixed-case caggs resolve correctly (an unquoted name case-folds
   * and fails — surfaced in the spike).
   *
   * If a scheduled refresh policy is running on the same cagg, the manual refresh briefly
   * retries (see SQLSTATE 55P03 below) instead of failing.
   */
  refreshContinuousAggregate(name: string, range?: RefreshRange): Promise<void>;
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

/** @param viewByModel Prisma view model name -> { DB view name, schema } (for @@map/@@schema). */
export function makeManage(
  client: RawClient,
  viewByModel: ReadonlyMap<string, CaggRef> = new Map(),
  options: ManageOptions = {},
): TimescaleManage {
  // Coerce to a finite integer >= 1. A NaN here would make the retry loop's `attempt <=
  // maxAttempts` guard false on the first iteration — a silent no-op that never runs the
  // refresh — and Infinity would retry unboundedly on repeated 55P03; both fall back to 8.
  const requestedAttempts = options.maxRefreshAttempts ?? 8;
  const maxAttempts = Number.isFinite(requestedAttempts) ? Math.max(1, Math.floor(requestedAttempts)) : 8;
  const sleep = options.sleep ?? defaultSleep;
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
  };
}
